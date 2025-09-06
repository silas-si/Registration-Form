// script.js
// Final feature-complete script for Profile Manager
// - Validation (stricter email regex, unique email checks, file size/type checks)
// - File upload handling with preview, spinner, and caching existing photo if edit and no new file
// - Edit / Cancel Edit functionality (card + table)
// - Remove confirmation
// - Debounced search/filter/sort with highlighting
// - LocalStorage persistence with try/catch and simple photo omission for large images
// - Accessibility improvements: aria-live announcements, focus handling
// - Lazy-loading images, mobile view-details expansion
// - Modular structure and comments for maintainability

document.addEventListener("DOMContentLoaded", () => {
  /* =========================
     DOM references
     ========================= */
  const form = document.getElementById("registrationForm");
  const firstNameInput = document.getElementById("firstName");
  const lastNameInput = document.getElementById("lastName");
  const emailInput = document.getElementById("email");
  const programmeInput = document.getElementById("programme");
  const yearInput = document.getElementById("year");
  const interestsInput = document.getElementById("interests");
  const photoFileInput = document.getElementById("photoFile");
  const formStatus = document.getElementById("formStatus") || document.getElementById("formStatus"); // fallback
  const cardsContainer = document.getElementById("cardsContainer");
  const summaryTable = document.getElementById("summaryTable");
  const summaryTbody = summaryTable.querySelector("tbody");
  const searchInput = document.getElementById("searchInput");
  const filterField = document.getElementById("filterField");
  const clearSearchBtn = document.getElementById("clearSearch");
  const cancelEditBtn = document.getElementById("cancelEdit");
  const loadingSpinner = document.getElementById("loadingSpinner");

  /* =========================
     App state
     ========================= */
  let profiles = {};       // { id: {firstName,lastName,email,programme,year,interests,photoUrl} }
  let profileId = 1;       // incremental id (persisted)
  let editingId = null;    // id of profile being edited
  let debounceTimer = null;
  const SEARCH_DEBOUNCE = 300; // ms
  const PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
  const PHOTO_STORE_THRESHOLD = 150 * 1024; // 150 KB - if bigger than this we'll omit storing the base64 for compression

  /* =========================
     Accessibility helpers
     ========================= */
  function announce(message, mode = "polite") {
    if (!formStatus) return;
    formStatus.textContent = message;
    formStatus.className = ""; // reset classes
    if (mode === "error") formStatus.classList.add("error");
    if (mode === "success") formStatus.classList.add("success");
    if (mode === "info") formStatus.classList.add("info");
  }

  /* =========================
     Utilities
     ========================= */
  function uid() {
    // simple id generator using timestamp + random
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function safeLocalStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (err) {
      console.error("localStorage set error:", err);
      announce("Could not save to localStorage (quota or privacy settings).", "error");
      return false;
    }
  }
  function safeLocalStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      console.error("localStorage get error:", err);
      return null;
    }
  }

  // Normalize emails for uniqueness: lowercase, and for gmail/googlemail remove dots and plus tags.
  function normalizeEmailForComparison(email) {
    if (!email) return "";
    email = email.trim().toLowerCase();
    const parts = email.split("@");
    if (parts.length !== 2) return email;
    let [local, domain] = parts;
    if (domain === "gmail.com" || domain === "googlemail.com") {
      // remove dots
      local = local.split("+")[0].replace(/\./g, "");
      return `${local}@${domain}`;
    }
    // For other domains, strip +tag but keep dots (safer)
    local = local.split("+")[0];
    return `${local}@${domain}`;
  }

  /* =========================
     Validation
     ========================= */
  // stricter email regex (common cases)
  const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

  function validateProfileInput(data, {isEdit = false, excludeId = null} = {}) {
    let valid = true;
    // clear previous inline errors
    clearError("firstName");
    clearError("lastName");
    clearError("email");
    clearError("programme");
    clearError("year");
    clearError("photoFile");
    clearError("interests");

    if (!data.firstName || data.firstName.trim().length < 1) {
      showError("firstName", "First name is required.");
      valid = false;
    }
    if (!data.lastName || data.lastName.trim().length < 1) {
      showError("lastName", "Last name is required.");
      valid = false;
    }
    if (!data.email || !EMAIL_RE.test(data.email)) {
      showError("email", "Valid email is required.");
      valid = false;
    } else {
      // Unique email check
      const normalized = normalizeEmailForComparison(data.email);
      for (const id in profiles) {
        if (excludeId && id === excludeId) continue;
        if (normalizeEmailForComparison(profiles[id].email) === normalized) {
          showError("email", "This email is already registered.");
          valid = false;
          break;
        }
      }
    }
    if (!data.programme || data.programme.trim() === "") {
      showError("programme", "Programme is required.");
      valid = false;
    }
    if (!data.year || data.year.trim() === "") {
      showError("year", "Year is required.");
      valid = false;
    }

    // interests: min 0, max 3 per UI hint
    if (data.interests && data.interests.length > 3) {
      showError("interests", "You can enter up to three interests.");
      valid = false;
    }

    // photo file validation handled separately on file read stage, but if a File was provided in data.file, check it
    if (data.file) {
      if (data.file.size > PHOTO_MAX_BYTES) {
        showError("photoFile", "Photo must be less than 2MB.");
        valid = false;
      }
      if (!["image/jpeg", "image/png"].includes(data.file.type)) {
        showError("photoFile", "Photo must be a JPG or PNG image.");
        valid = false;
      }
    }
    return valid;
  }

  function showError(fieldId, message) {
    const el = document.getElementById(fieldId + "Error");
    if (el) {
      el.textContent = message;
      el.setAttribute("role", "alert");
    }
  }
  function clearError(fieldId) {
    const el = document.getElementById(fieldId + "Error");
    if (el) {
      el.textContent = "";
      el.removeAttribute("role");
    }
  }

  // dynamic error clearing when user types/changes an input
  [firstNameInput, lastNameInput, emailInput, programmeInput, yearInput, photoFileInput, interestsInput].forEach(inp => {
    if (!inp) return;
    inp.addEventListener("input", (e) => {
      clearError(inp.id);
    });
  });

  /* =========================
     Storage (with compression approach)
     ========================= */
  const STORAGE_KEY = "profile_manager_v1";

  // When storing, omit photoUrl if it's large (saves quota). We'll place a flag photoOmitted: true when omitted.
  function persistProfiles() {
    const payload = {
      profileId,
      profiles: {}
    };
    // Build minimal payload
    for (const id in profiles) {
      const p = profiles[id];
      const copy = {...p};
      if (copy.photoUrl && copy.photoUrl.length > PHOTO_STORE_THRESHOLD) {
        // omit large base64 to save space
        copy._photoOmitted = true;
        copy.photoUrl = null;
      } else {
        copy._photoOmitted = false;
      }
      payload.profiles[id] = copy;
    }

    try {
      safeLocalStorageSet(STORAGE_KEY, JSON.stringify(payload));
      console.debug("Profiles persisted (compression applied).");
      return true;
    } catch (err) {
      console.error("Persist failed:", err);
      announce("Failed to save profiles to localStorage.", "error");
      return false;
    }
  }

  function loadProfilesFromStorage() {
    const raw = safeLocalStorageGet(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      profileId = parsed.profileId || profileId;
      profiles = parsed.profiles || {};
      // Rebuild UI
      for (const id of Object.keys(profiles)) {
        renderProfileToUI(id, profiles[id]);
      }
      announce("Profiles loaded from storage.", "info");
    } catch (err) {
      console.error("Failed to parse stored profiles:", err);
    }
  }

  /* =========================
     Rendering helpers
     ========================= */
  function clearCardsAndTable() {
    cardsContainer.innerHTML = "";
    summaryTbody.innerHTML = "";
  }

  function renderProfileToUI(id, data) {
    // --- Render to table ---
    let tr = document.getElementById("row-" + id);
    if (!tr) {
      tr = document.createElement("tr");
      tr.id = "row-" + id;
      summaryTbody.appendChild(tr);
    }
    tr.innerHTML = "";

    const cells = [
      { label: "ID", value: id },
      { label: "Photo", value: `<img src="${data.photoUrl || getPlaceholderImage(data.firstName, data.lastName)}" alt="Profile photo" style="width:48px;height:48px;object-fit:cover;border-radius:50%;">` },
      { label: "First Name", value: data.firstName },
      { label: "Last Name", value: data.lastName },
      { label: "Email", value: data.email },
      { label: "Programme", value: data.programme },
      { label: "Year", value: data.year },
      { label: "Interests", value: (data.interests || []).join(", ") },
      { label: "Actions", value: "" }
    ];

    cells.forEach((c, idx) => {
      const td = document.createElement("td");
      td.setAttribute("data-label", c.label);
      if (c.label === "Photo") {
        td.innerHTML = c.value;
      } else if (c.label === "Actions") {
        const editBtnRow = document.createElement("button");
        editBtnRow.className = "edit-btn";
        editBtnRow.type = "button";
        editBtnRow.textContent = "Edit";
        editBtnRow.setAttribute("aria-label", `Edit profile ${data.firstName} ${data.lastName}`);
        editBtnRow.addEventListener("click", () => beginEditProfile(id));

        const removeBtnRow = document.createElement("button");
        removeBtnRow.className = "remove-btn";
        removeBtnRow.type = "button";
        removeBtnRow.textContent = "Remove";
        removeBtnRow.setAttribute("aria-label", `Remove profile ${data.firstName} ${data.lastName}`);
        removeBtnRow.addEventListener("click", () => confirmAndRemove(id));

        const container = document.createElement("div");
        container.className = "td-actions";
        container.appendChild(editBtnRow);
        container.appendChild(removeBtnRow);

        td.appendChild(container);
      } else {
        td.textContent = c.value;
      }
      tr.appendChild(td);
    });

    // --- Render to cards ---
    let card = document.getElementById("card-" + id);
    if (!card) {
      card = document.createElement("div");
      card.className = "profile-card fade-in";
      card.id = "card-" + id;
      card.setAttribute("data-id", id); // <-- Add this line!
      cardsContainer.appendChild(card);
    }
    card.innerHTML = `
      <img src="${data.photoUrl || getPlaceholderImage(data.firstName, data.lastName)}" alt="Profile photo of ${data.firstName} ${data.lastName}">
      <div class="card-body">
        <h4>${data.firstName} ${data.lastName}</h4>
        <p><strong>Email:</strong> ${data.email}</p>
        <p><strong>Programme:</strong> ${data.programme}</p>
        <p><strong>Year:</strong> ${data.year}</p>
        <p><strong>Interests:</strong> ${(data.interests || []).join(", ")}</p>
        <div class="card-actions">
          <button type="button" class="edit-btn" aria-label="Edit profile" onclick="window.beginEditProfile && beginEditProfile('${id}')">Edit</button>
          <button type="button" class="remove-btn" aria-label="Remove profile" onclick="window.confirmAndRemove && confirmAndRemove('${id}')">Remove</button>
        </div>
      </div>
    `;
  }

  function rerenderAll() {
    clearCardsAndTable();
    const entries = Object.entries(profiles);
    sortProfiles(entries).forEach(([id, data]) => renderProfileToUI(id, data));
  }

  /* =========================
     Helpers: placeholders & image handling
     ========================= */
  function getPlaceholderImage(first, last) {
    // simple gradient placeholder dataURI or external service would be nicer,
    // but to avoid external calls we'll return a subtle SVG data URI
    const initials = ((first || "").charAt(0) + (last || "").charAt(0)).toUpperCase() || "U";
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='180'>
      <defs><linearGradient id='g' x1='0' x2='1'><stop stop-color='#e0f2f1' offset='0'/><stop stop-color='#b2dfdb' offset='1'/></linearGradient></defs>
      <rect width='100%' height='100%' fill='url(#g)'/>
      <text x='50%' y='55%' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='48' fill='#00695c'>${initials}</text>
    </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  /* =========================
     CRUD operations
     ========================= */
  function createNewProfileObjectFromForm() {
    // Parse interests from comma-separated string, trim, remove empty, max 3
    let interestsArr = [];
    if (interestsInput && interestsInput.value) {
      interestsArr = interestsInput.value
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 3);
    }
    return {
      firstName: firstNameInput.value.trim(),
      lastName: lastNameInput.value.trim(),
      email: emailInput.value.trim(),
      programme: programmeInput.value,
      year: yearInput.value,
      interests: interestsArr,
      file: photoFileInput.files && photoFileInput.files[0] ? photoFileInput.files[0] : null
    };
  }

  // begin editing a profile: populate form and show cancel button
  function beginEditProfile(id) {
    const data = profiles[id];
    if (!data) return;
    editingId = id;

    form.firstName.value = data.firstName;
    form.lastName.value = data.lastName;
    form.email.value = data.email;
    form.programme.value = data.programme;
    form.year.value = data.year;
    interestsInput.value = data.interests.join(", "); // comma-separated

    // Clear file input (can't programmatically set File input value to a dataURL)
    photoFileInput.value = "";

    // create or update hidden existingPhotoUrl input to preserve existing image if no new file chosen
    let hidden = document.getElementById("existingPhotoUrl");
    if (!hidden) {
      hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.id = "existingPhotoUrl";
      hidden.name = "existingPhotoUrl";
      form.appendChild(hidden);
    }
    hidden.value = data.photoUrl || "";

    // show cancel edit button
    cancelEditBtn.hidden = false;
    cancelEditBtn.addEventListener("click", cancelEdit, { once: true });

    // visually mark the card being edited
    rerenderAll();
    const card = cardsContainer.querySelector(`.profile-card[data-id="${id}"]`);
    if (card) card.setAttribute("aria-current", "true");

    // Focus first field
    firstNameInput.focus();

    announce(`Editing profile ${id}. Form populated.`, "info");
  }

  function cancelEdit() {
    editingId = null;
    cancelEditBtn.hidden = true;
    form.reset();
    // remove any hidden existingPhotoUrl
    const hidden = document.getElementById("existingPhotoUrl");
    if (hidden) hidden.remove();
    rerenderAll();
    announce("Edit cancelled.", "info");
  }

  function confirmAndRemove(id) {
    const profile = profiles[id];
    const name = profile ? `${profile.firstName} ${profile.lastName}` : id;
    if (!confirm(`Are you sure you want to remove profile "${name}"? This cannot be undone.`)) {
      announce("Deletion cancelled.", "info");
      return;
    }
    // proceed
    delete profiles[id];
    persistProfiles();
    rerenderAll();
    announce(`Profile ${id} removed.`, "success");
  }

  /* =========================
     Save logic (handles file encoding, validation, storing)
     ========================= */
  function saveProfileFromForm() {
    const dataObj = createNewProfileObjectFromForm();

    // If editing, exclude the currently edited id when checking unique email
    const isValid = validateProfileInput(dataObj, { isEdit: !!editingId, excludeId: editingId });
    if (!isValid) {
      announce("Please fix form errors before submitting.", "error");
      return;
    }

    // If file present -> validate and read as data URL
    if (dataObj.file) {
      // show spinner
      if (loadingSpinner) loadingSpinner.hidden = false;

      const f = dataObj.file;
      // extra validation again (defensive)
      const allowedTypes = ["image/jpeg", "image/png", "image/jpg"];
      if (!allowedTypes.includes(f.type)) {
        showError("photoFile", "Only JPG/PNG files are allowed.");
        if (loadingSpinner) loadingSpinner.hidden = true;
        return;
      }
      if (f.size > PHOTO_MAX_BYTES) {
        showError("photoFile", "File too large. Max 2MB.");
        if (loadingSpinner) loadingSpinner.hidden = true;
        return;
      }

      const reader = new FileReader();
      reader.onload = function(ev) {
        const dataUrl = ev.target.result;
        dataObj.photoUrl = dataUrl;
        dataObj.file = null; // we no longer need the file object

        finalizeSave(dataObj);
        if (loadingSpinner) loadingSpinner.hidden = true;
      };
      reader.onerror = function(e) {
        console.error("FileReader error:", e);
        showError("photoFile", "Failed to read image file.");
        if (loadingSpinner) loadingSpinner.hidden = true;
      };
      reader.readAsDataURL(f);
    } else {
      // No new file: if existingPhotoUrl hidden input exists (during edit) use that; else no photo
      const hidden = document.getElementById("existingPhotoUrl");
      if (hidden && hidden.value) {
        dataObj.photoUrl = hidden.value;
      } else {
        dataObj.photoUrl = null;
      }
      finalizeSave(dataObj);
    }
  }

  // finalizeSave: create or update record, persist, rerender, reset form
  function finalizeSave(profileData) {
    if (editingId) {
      // update existing
      profiles[editingId] = {
        ...profiles[editingId], // keep any other fields
        ...profileData
      };
      // ensure id remains same
      announce(`Profile ${editingId} updated successfully.`, "success");
    } else {
      // create new id; ensure uniqueness of email enforced earlier
      const id = uid();
      profiles[id] = profileData;
      profileId = Math.max(profileId, Date.now()); // bump profileId in case
      announce(`Profile added successfully with ID ${id}.`, "success");
    }

    // persist with compression strategy
    const ok = persistProfiles();
    if (!ok) {
      // persisted failed; still keep in memory but notify
      announce("Saved locally but could not persist to localStorage.", "error");
    }

    // cleanup UI
    form.reset();
    const hidden = document.getElementById("existingPhotoUrl");
    if (hidden) hidden.remove();
    editingId = null;
    cancelEditBtn.hidden = true;
    rerenderAll();
  }

  /* =========================
     Sorting, filtering, search (with debounce + highlighting)
     ========================= */
  function sortProfiles(entriesArray) {
    // entriesArray: [ [id, data], ... ]
    const sortBy = (document.getElementById("sortBy") || { value: "id-asc" }).value;
    entriesArray.sort((a, b) => {
      const [, A] = a;
      const [, B] = b;
      switch (sortBy) {
        case "id-desc": return String(b[0]).localeCompare(String(a[0]));
        case "name-asc": return (A.firstName + A.lastName).localeCompare(B.firstName + B.lastName);
        case "name-desc": return (B.firstName + B.lastName).localeCompare(A.firstName + A.lastName);
        case "year-asc": return (Number(A.year) || 0) - (Number(B.year) || 0);
        case "year-desc": return (Number(B.year) || 0) - (Number(A.year) || 0);
        default: // id-asc
          return String(a[0]).localeCompare(String(b[0]));
      }
    });
    return entriesArray;
  }

  function highlightMatches(text, query) {
    if (!query) return text;
    // escape regex special chars
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${esc})`, "gi");
    return text.replace(re, (m) => `<mark>${m}</mark>`);
  }

  function applyFilterAndSearch() {
    const rawQuery = (searchInput && searchInput.value) ? searchInput.value.trim() : "";
    const query = rawQuery.toLowerCase();
    const field = (filterField && filterField.value) ? filterField.value : "all";

    // Rerender UI but hide non-matching elements and highlight matches
    // We'll rebuild the table/cards based on in-memory profiles
    clearCardsAndTable();
    const entries = Object.entries(profiles);
    const sorted = sortProfiles(entries);

    for (const [id, data] of sorted) {
      // determine searchable text based on selected field
      let hay = "";
      if (field === "all") {
        hay = `${data.firstName} ${data.lastName} ${data.email} ${data.programme} ${data.year} ${data.interests.join(" ")}`.toLowerCase();
      } else if (field === "firstName") {
        hay = (data.firstName || "").toLowerCase();
      } else if (field === "lastName") {
        hay = (data.lastName || "").toLowerCase();
      } else if (field === "email") {
        hay = (data.email || "").toLowerCase();
      } else if (field === "programme") {
        hay = (data.programme || "").toLowerCase();
      } else if (field === "year") {
        hay = String(data.year || "").toLowerCase();
      } else if (field === "interests") {
        hay = (data.interests || []).join(" ").toLowerCase();
      }

      const matches = !query || hay.includes(query);

      if (!matches) continue;

      // Render card and table row with highlighted text
      renderProfileToUIWithHighlight(id, data, query);
    }

    announce(rawQuery ? `Filtered results for "${rawQuery}".` : "Search cleared.", rawQuery ? "info" : "info");
  }

  // render but with highlighting for matches (used in filtered display)
  function renderProfileToUIWithHighlight(id, data, query) {
    // create card as in renderProfileToUI, but mask text with highlight markup
    const card = document.createElement("article");
    card.className = "profile-card fade-in";
    card.setAttribute("data-id", id);
    card.setAttribute("role", "listitem");

    const img = document.createElement("img");
    img.setAttribute("alt", `${data.firstName} ${data.lastName} photo`);
    img.loading = "lazy";
    img.src = data.photoUrl || getPlaceholderImage(data.firstName, data.lastName);
    img.onerror = () => { img.src = getPlaceholderImage(data.firstName, data.lastName); };

    const body = document.createElement("div");
    body.className = "card-body";

    const name = document.createElement("h4");
    name.innerHTML = highlightMatches(`${data.firstName} ${data.lastName}`, query);

    const emailP = document.createElement("p");
    emailP.innerHTML = highlightMatches(data.email, query);

    const programmeP = document.createElement("p");
    programmeP.innerHTML = highlightMatches(`${data.programme} • Year ${data.year}`, query);

    const interestsP = document.createElement("p");
    interestsP.innerHTML = highlightMatches(data.interests && data.interests.length ? `Interests: ${data.interests.join(", ")}` : "No interests", query);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const editBtn = document.createElement("button");
    editBtn.className = "edit-btn"; editBtn.type = "button"; editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => beginEditProfile(id));
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn"; removeBtn.type = "button"; removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => confirmAndRemove(id));
    actions.appendChild(editBtn); actions.appendChild(removeBtn);

    body.appendChild(name); body.appendChild(emailP); body.appendChild(programmeP); body.appendChild(interestsP); body.appendChild(actions);
    card.appendChild(img); card.appendChild(body);
    cardsContainer.appendChild(card);

    // Table row
    const tr = document.createElement("tr");
    tr.setAttribute("data-id", id);
    const htmlPhoto = `<img src="${img.src}" alt="${data.firstName} ${data.lastName} photo" loading="lazy" style="width:48px;height:48px;object-fit:cover;border-radius:6px;">`;
    const tdValues = [
      id,
      htmlPhoto,
      highlightMatches(data.firstName, query),
      highlightMatches(data.lastName, query),
      highlightMatches(data.email, query),
      highlightMatches(data.programme, query),
      highlightMatches(String(data.year), query),
      highlightMatches(data.interests && data.interests.length ? data.interests.join(", ") : "—", query)
    ];

    tdValues.forEach((val, i) => {
      const td = document.createElement("td");
      td.setAttribute("data-label", ["ID","Photo","First Name","Last Name","Email","Programme","Year","Interests"][i] || "");
      if (i === 1) {
        td.innerHTML = val;
      } else {
        td.innerHTML = val;
      }
      tr.appendChild(td);
    });

    // actions cell
    const actionTd = document.createElement("td");
    actionTd.setAttribute("data-label", "Actions");
    const editBtnRow = document.createElement("button");
    editBtnRow.className = "edit-btn"; editBtnRow.type = "button"; editBtnRow.textContent = "Edit";
    editBtnRow.addEventListener("click", () => beginEditProfile(id));
    const removeBtnRow = document.createElement("button");
    removeBtnRow.className = "remove-btn"; removeBtnRow.type = "button"; removeBtnRow.textContent = "Remove";
    removeBtnRow.addEventListener("click", () => confirmAndRemove(id));
    const wrap = document.createElement("div"); wrap.className = "td-actions"; wrap.append(editBtnRow, removeBtnRow);
    actionTd.appendChild(wrap);
    tr.appendChild(actionTd);

    summaryTbody.appendChild(tr);
  }

  /* =========================
     Event handlers
     ========================= */
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveProfileFromForm();
  });

  // Reset clears errors and cancels edit
  form.addEventListener("reset", () => {
    // small timeout to allow fields to clear
    setTimeout(() => {
      ["firstName","lastName","email","programme","year","photoFile","interests"].forEach(clearError);
      cancelEdit();
    }, 0);
  });

  // Debounced search
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        applyFilterAndSearch();
        debounceTimer = null;
      }, SEARCH_DEBOUNCE);
      // toggle clear button
      if (clearSearchBtn) clearSearchBtn.style.display = searchInput.value ? "inline-block" : "none";
    });
  }

  if (filterField) {
    filterField.addEventListener("change", () => {
      applyFilterAndSearch();
    });
  }

  if (clearSearchBtn) {
    clearSearchBtn.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      applyFilterAndSearch();
      announce("Search cleared.", "info");
      clearSearchBtn.style.display = "none";
    });
    clearSearchBtn.style.display = "none";
  }

  // cancel edit button
  if (cancelEditBtn) {
    cancelEditBtn.addEventListener("click", cancelEdit);
    cancelEditBtn.hidden = true;
  }

  /* =========================
     Initialization
     ========================= */
  // load saved profiles
  loadProfilesFromStorage();

  // If no profiles yet, show a helpful message in UI (optional)
  if (Object.keys(profiles).length === 0) {
    announce("No profiles yet. Use the form to add one.", "info");
  } else {
    // re-render to ensure highlights cleared
    rerenderAll();
  }
});
