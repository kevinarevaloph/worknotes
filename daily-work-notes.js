(() => {
  "use strict";

  /* =========================================================
     DAILY WORK NOTES
     Simple Notepad + Work Tabs + Spreadsheet Tables
     Supabase Cloud Storage + Local Backup
     ========================================================= */

  const STORAGE_KEY = "kevin_daily_work_notes_v3";

  /* =========================================================
     SUPABASE
     ========================================================= */

  const SUPABASE_URL =
    "https://qqvsfbpheacaqrvvdjbp.supabase.co";

  const SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_Dd7Nm5oTNLKuHj6JA_R01Q_yJqk8JCX";

  let supabaseClient = null;

  if (
    window.supabase &&
    typeof window.supabase.createClient === "function"
  ) {
    supabaseClient = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY
    );
  } else {
    console.error(
      "Supabase library was not loaded."
    );
  }

  /* =========================================================
     STATE
     ========================================================= */

  let state = {
    notes: [],
    activeId: ""
  };

  let savedSelection = null;
  let saveTimer = null;
  let cloudSaveTimer = null;

  let isCloudLoading = false;
  let isCloudSaving = false;

  /* =========================================================
     DOM HELPERS
     ========================================================= */

  const $ = (id) => document.getElementById(id);

  const newWorkTab = $("newWorkTab");
  const addTabButton = $("addTabButton");

  const workTabs = $("workTabs");
  const tabCount = $("tabCount");
  const tabSearch = $("tabSearch");
  const clearSearch = $("clearSearch");

  const documentWorkspace = $("documentWorkspace");
  const emptyWorkspace = $("emptyWorkspace");

  const noteTitle = $("noteTitle");
  const noteDate = $("noteDate");
  const noteEditor = $("noteEditor");

  const duplicateNote = $("duplicateNote");
  const deleteNote = $("deleteNote");

  const insertTable = $("insertTable");
  const addRow = $("addRow");
  const addColumn = $("addColumn");
  const deleteRow = $("deleteRow");
  const deleteColumn = $("deleteColumn");

  const saveNoteButton = $("saveNote");
  const saveIndicator = $("saveIndicator");

  const year = $("year");

  /* =========================================================
     TAB DRAG STATE
     ========================================================= */

  let draggedTab = null;
  let draggedNoteId = "";
  let dragStartX = 0;
  let dragStartY = 0;
  let isDraggingTab = false;
  let suppressNextClick = false;

  const DRAG_THRESHOLD = 6;

  /* =========================================================
     INITIALIZATION
     ========================================================= */

  init();

  async function init() {
    loadLocalState();

    if (year) {
      year.textContent =
        new Date().getFullYear();
    }

    bindEvents();
    render();

    if (!state.notes.length) {
      createNote();
    }

    /*
     * Load cloud notes after the local interface
     * has been initialized.
     */
    await loadCloudState();
  }

  /* =========================================================
     LOCAL STORAGE
     ========================================================= */

  function loadLocalState() {
    try {
      const saved =
        localStorage.getItem(
          STORAGE_KEY
        );

      if (!saved) {
        return;
      }

      const parsed =
        JSON.parse(saved);

      if (
        !parsed ||
        !Array.isArray(parsed.notes)
      ) {
        return;
      }

      state.notes =
        parsed.notes;

      state.activeId =
        parsed.activeId || "";

      normalizeLocalNotes();

      if (
        state.activeId &&
        !state.notes.some(
          (note) =>
            note.id ===
            state.activeId
        )
      ) {
        state.activeId =
          state.notes.length
            ? state.notes[0].id
            : "";
      }
    } catch (error) {
      console.error(
        "Could not load Daily Work Notes from localStorage:",
        error
      );
    }
  }

  function saveLocalState() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(state)
      );
    } catch (error) {
      console.error(
        "Could not save Daily Work Notes to localStorage:",
        error
      );
    }
  }

  function normalizeLocalNotes() {
    state.notes =
      state.notes.map(
        (note) => ({
          id:
            note.id ||
            generateId(),

          title:
            note.title ||
            "Untitled Note",

          date:
            note.date ||
            getToday(),

          content:
            typeof note.content ===
            "string"
              ? note.content
              : "",

          createdAt:
            Number(
              note.createdAt
            ) ||
            Date.now(),

          updatedAt:
            Number(
              note.updatedAt
            ) ||
            Date.now()
        })
      );
  }

  /* =========================================================
     SUPABASE CLOUD STORAGE
     ========================================================= */

  async function loadCloudState() {
    if (!supabaseClient) {
      updateSaveIndicator(
        "Local backup"
      );

      return;
    }

    if (isCloudLoading) {
      return;
    }

    isCloudLoading = true;

    updateSaveIndicator(
      "Loading..."
    );

    try {
      const {
        data,
        error
      } =
        await supabaseClient
          .from(
            "daily_work_notes"
          )
          .select(
            "id, title, note_date, content, created_at, updated_at"
          )
          .order(
            "updated_at",
            {
              ascending: false
            }
          );

      if (error) {
        throw error;
      }

      const cloudNotes =
        Array.isArray(data)
          ? data.map(
              cloudRowToLocalNote
            )
          : [];

      /*
       * =======================================================
       * CLOUD IS EMPTY
       * =======================================================
       *
       * If the user already has notes stored locally,
       * upload them to Supabase.
       */
      if (
        cloudNotes.length === 0 &&
        state.notes.length > 0
      ) {
        await migrateLocalNotesToCloud();

        updateSaveIndicator(
          "Saved to cloud"
        );

        return;
      }

      /*
       * =======================================================
       * CLOUD HAS NOTES
       * =======================================================
       *
       * Merge cloud and local notes.
       *
       * If the same note exists in both places,
       * the newer version wins.
       */
      const mergedNotes =
        mergeLocalAndCloudNotes(
          state.notes,
          cloudNotes
        );

      state.notes =
        mergedNotes;

      if (
        state.activeId &&
        state.notes.some(
          (note) =>
            note.id ===
            state.activeId
        )
      ) {
        /*
         * Keep current active note.
         */
      } else {
        state.activeId =
          state.notes.length
            ? state.notes[0].id
            : "";
      }

      saveLocalState();
      render();

      /*
       * Upload any local-only/newer notes
       * that aren't already represented in cloud.
       */
      await synchronizeMergedNotes(
        state.notes,
        cloudNotes
      );

      updateSaveIndicator(
        "Saved to cloud"
      );
    } catch (error) {
      console.error(
        "Could not load Daily Work Notes from Supabase:",
        error
      );

      /*
       * Keep working with localStorage if
       * the cloud is temporarily unavailable.
       */
      updateSaveIndicator(
        "Local backup"
      );
    } finally {
      isCloudLoading = false;
    }
  }

  function cloudRowToLocalNote(
    row
  ) {
    return {
      id:
        row.id,

      title:
        row.title ||
        "Untitled Note",

      date:
        row.note_date ||
        getToday(),

      content:
        typeof row.content ===
        "string"
          ? row.content
          : "",

      createdAt:
        parseTimestamp(
          row.created_at
        ),

      updatedAt:
        parseTimestamp(
          row.updated_at
        )
    };
  }

  function parseTimestamp(
    value
  ) {
    if (
      typeof value ===
      "number"
    ) {
      return value;
    }

    const parsed =
      Date.parse(
        value || ""
      );

    return Number.isFinite(
      parsed
    )
      ? parsed
      : Date.now();
  }

  function localNoteToCloudRow(
    note
  ) {
    return {
      id:
        note.id,

      title:
        note.title ||
        "Untitled Note",

      note_date:
        note.date ||
        getToday(),

      content:
        note.content || "",

      created_at:
        new Date(
          Number(
            note.createdAt
          ) || Date.now()
        ).toISOString(),

      updated_at:
        new Date(
          Number(
            note.updatedAt
          ) || Date.now()
        ).toISOString()
    };
  }

  function mergeLocalAndCloudNotes(
    localNotes,
    cloudNotes
  ) {
    const cloudMap =
      new Map(
        cloudNotes.map(
          (note) => [
            note.id,
            note
          ]
        )
      );

    const localMap =
      new Map(
        localNotes.map(
          (note) => [
            note.id,
            note
          ]
        )
      );

    const result = [];

    /*
     * Preserve the user's existing local
     * tab order wherever possible.
     */
    localNotes.forEach(
      (localNote) => {
        const cloudNote =
          cloudMap.get(
            localNote.id
          );

        if (!cloudNote) {
          result.push(
            localNote
          );

          return;
        }

        const localUpdated =
          Number(
            localNote.updatedAt
          ) || 0;

        const cloudUpdated =
          Number(
            cloudNote.updatedAt
          ) || 0;

        if (
          localUpdated >
          cloudUpdated
        ) {
          result.push(
            localNote
          );
        } else {
          result.push(
            cloudNote
          );
        }
      }
    );

    /*
     * Add cloud notes that don't exist
     * locally.
     */
    cloudNotes.forEach(
      (cloudNote) => {
        if (
          !localMap.has(
            cloudNote.id
          )
        ) {
          result.push(
            cloudNote
          );
        }
      }
    );

    return result;
  }

  async function migrateLocalNotesToCloud() {
    if (
      !supabaseClient ||
      !state.notes.length
    ) {
      return;
    }

    updateSaveIndicator(
      "Saving to cloud..."
    );

    const rows =
      state.notes.map(
        localNoteToCloudRow
      );

    const {
      error
    } =
      await supabaseClient
        .from(
          "daily_work_notes"
        )
        .upsert(
          rows,
          {
            onConflict:
              "id"
          }
        );

    if (error) {
      throw error;
    }
  }

  async function synchronizeMergedNotes(
    mergedNotes,
    originalCloudNotes
  ) {
    if (!supabaseClient) {
      return;
    }

    const cloudMap =
      new Map(
        originalCloudNotes.map(
          (note) => [
            note.id,
            note
          ]
        )
      );

    const notesToUpload =
      mergedNotes.filter(
        (note) => {
          const cloudNote =
            cloudMap.get(
              note.id
            );

          if (!cloudNote) {
            return true;
          }

          return (
            Number(
              note.updatedAt
            ) >
            Number(
              cloudNote.updatedAt
            )
          );
        }
      );

    if (
      !notesToUpload.length
    ) {
      return;
    }

    const rows =
      notesToUpload.map(
        localNoteToCloudRow
      );

    const {
      error
    } =
      await supabaseClient
        .from(
          "daily_work_notes"
        )
        .upsert(
          rows,
          {
            onConflict:
              "id"
          }
        );

    if (error) {
      throw error;
    }
  }

  /* =========================================================
     CLOUD SAVE
     ========================================================= */

  function scheduleCloudSave(
    note
  ) {
    if (
      !supabaseClient ||
      !note
    ) {
      return;
    }

    clearTimeout(
      cloudSaveTimer
    );

    cloudSaveTimer =
      setTimeout(
        () => {
          saveNoteToCloud(
            note
          );
        },
        700
      );
  }

  async function saveNoteToCloud(
    note
  ) {
    if (
      !supabaseClient ||
      !note
    ) {
      return false;
    }

    if (isCloudSaving) {
      /*
       * The next scheduled save will catch
       * any changes made while a save is running.
       */
      return false;
    }

    isCloudSaving = true;

    try {
      const row =
        localNoteToCloudRow(
          note
        );

      const {
        error
      } =
        await supabaseClient
          .from(
            "daily_work_notes"
          )
          .upsert(
            row,
            {
              onConflict:
                "id"
            }
          );

      if (error) {
        throw error;
      }

      return true;
    } catch (error) {
      console.error(
        "Could not save note to Supabase:",
        error
      );

      updateSaveIndicator(
        "Local backup"
      );

      return false;
    } finally {
      isCloudSaving = false;
    }
  }

  async function deleteNoteFromCloud(
    noteId
  ) {
    if (
      !supabaseClient ||
      !noteId
    ) {
      return false;
    }

    try {
      const {
        error
      } =
        await supabaseClient
          .from(
            "daily_work_notes"
          )
          .delete()
          .eq(
            "id",
            noteId
          );

      if (error) {
        throw error;
      }

      return true;
    } catch (error) {
      console.error(
        "Could not delete note from Supabase:",
        error
      );

      return false;
    }
  }

  /* =========================================================
     UTILITIES
     ========================================================= */

  function generateId() {
    return (
      "note-" +
      Date.now().toString(36) +
      "-" +
      Math.random()
        .toString(36)
        .slice(2, 8)
    );
  }

  function getToday() {
    const date =
      new Date();

    const yearValue =
      date.getFullYear();

    const monthValue =
      String(
        date.getMonth() + 1
      ).padStart(
        2,
        "0"
      );

    const dayValue =
      String(
        date.getDate()
      ).padStart(
        2,
        "0"
      );

    return `${yearValue}-${monthValue}-${dayValue}`;
  }

  function getActiveNote() {
    return state.notes.find(
      (note) =>
        note.id ===
        state.activeId
    );
  }

  function escapeHtml(value) {
    return String(value)
      .replace(
        /&/g,
        "&amp;"
      )
      .replace(
        /</g,
        "&lt;"
      )
      .replace(
        />/g,
        "&gt;"
      )
      .replace(
        /"/g,
        "&quot;"
      )
      .replace(
        /'/g,
        "&#039;"
      );
  }

  /* =========================================================
     NOTE CREATION
     ========================================================= */

  function createNote() {
    saveCurrentEditor();

    const now =
      Date.now();

    const note = {
      id:
        generateId(),

      title:
        "Untitled Note",

      date:
        getToday(),

      content:
        "",

      createdAt:
        now,

      updatedAt:
        now
    };

    state.notes.push(
      note
    );

    state.activeId =
      note.id;

    saveLocalState();

    render();

    /*
     * Save immediately to Supabase.
     */
    saveNoteToCloud(
      note
    );

    focusNewNoteTitle();
  }

  function focusNewNoteTitle() {
    if (!noteTitle) {
      return;
    }

    requestAnimationFrame(
      () => {
        noteTitle.focus();

        try {
          noteTitle.select();
        } catch (error) {
          // Ignore selection errors.
        }
      }
    );
  }

  /* =========================================================
     RENDER
     ========================================================= */

  function render() {
    renderTabs();
    renderDocument();
    updateTabCount();
    updateTableButtons();
  }

  /* =========================================================
     TABS
     ========================================================= */

  function renderTabs() {
    if (!workTabs) {
      return;
    }

    const searchTerm =
      tabSearch
        ? tabSearch.value
            .trim()
            .toLowerCase()
        : "";

    workTabs.innerHTML =
      "";

    const filteredNotes =
      state.notes.filter(
        (note) => {
          if (!searchTerm) {
            return true;
          }

          return (
            String(
              note.title || ""
            )
              .toLowerCase()
              .includes(
                searchTerm
              ) ||
            String(
              note.date || ""
            )
              .toLowerCase()
              .includes(
                searchTerm
              )
          );
        }
      );

    filteredNotes.forEach(
      (note) => {
        const tab =
          document.createElement(
            "div"
          );

        tab.className =
          "note-tab";

        tab.dataset.noteId =
          note.id;

        if (
          note.id ===
          state.activeId
        ) {
          tab.classList.add(
            "active"
          );
        }

        const tabMain =
          document.createElement(
            "button"
          );

        tabMain.type =
          "button";

        tabMain.className =
          "tab-main";

        tabMain.dataset.noteId =
          note.id;

        tabMain.setAttribute(
          "aria-label",
          `Open ${
            note.title ||
            "Untitled Note"
          }`
        );

        tabMain.innerHTML = `
          <span class="tab-text">
            <span class="tab-title">
              ${escapeHtml(
                note.title ||
                  "Untitled Note"
              )}
            </span>

            <span class="tab-date">
              ${escapeHtml(
                note.date || ""
              )}
            </span>
          </span>
        `;

        tabMain.addEventListener(
          "click",
          (event) => {
            if (
              suppressNextClick
            ) {
              suppressNextClick =
                false;

              event.preventDefault();

              return;
            }

            activateNote(
              note.id
            );
          }
        );

        const closeButton =
          document.createElement(
            "button"
          );

        closeButton.type =
          "button";

        closeButton.className =
          "tab-close";

        closeButton.dataset.noteId =
          note.id;

        closeButton.setAttribute(
          "aria-label",
          `Delete ${
            note.title ||
            "note"
          }`
        );

        closeButton.title =
          "Delete note";

        closeButton.textContent =
          "×";

        closeButton.addEventListener(
          "pointerdown",
          (event) => {
            event.stopPropagation();
          }
        );

        closeButton.addEventListener(
          "click",
          (event) => {
            event.stopPropagation();

            deleteNoteById(
              note.id
            );
          }
        );

        attachTabDragEvents(
          tab,
          tabMain
        );

        tab.appendChild(
          tabMain
        );

        tab.appendChild(
          closeButton
        );

        workTabs.appendChild(
          tab
        );
      }
    );

    if (addTabButton) {
      const addButton =
        addTabButton.cloneNode(
          true
        );

      addButton.removeAttribute(
        "id"
      );

      addButton.classList.remove(
        "add-work-tab"
      );

      /*
       * Make sure the correct class
       * used by your CSS remains.
       */
      if (
        !addButton.classList.contains(
          "add-tab-btn"
        )
      ) {
        addButton.classList.add(
          "add-tab-btn"
        );
      }

      addButton.addEventListener(
        "click",
        createNote
      );

      workTabs.appendChild(
        addButton
      );
    }
  }

  function updateTabCount() {
    if (!tabCount) {
      return;
    }

    const count =
      state.notes.length;

    tabCount.textContent =
      count === 1
        ? "1 note"
        : `${count} notes`;
  }

  /* =========================================================
     MOVABLE TABS
     ========================================================= */

  function attachTabDragEvents(
    tab,
    tabMain
  ) {
    tabMain.style.touchAction =
      "none";

    tabMain.addEventListener(
      "pointerdown",
      handleTabPointerDown
    );

    tabMain.addEventListener(
      "pointermove",
      handleTabPointerMove
    );

    tabMain.addEventListener(
      "pointerup",
      handleTabPointerUp
    );

    tabMain.addEventListener(
      "pointercancel",
      handleTabPointerCancel
    );
  }

  function handleTabPointerDown(
    event
  ) {
    if (
      event.isPrimary === false
    ) {
      return;
    }

    const button =
      event.currentTarget;

    const tab =
      button.closest(
        ".note-tab"
      );

    if (!tab) {
      return;
    }

    draggedTab =
      tab;

    draggedNoteId =
      tab.dataset.noteId ||
      "";

    dragStartX =
      event.clientX;

    dragStartY =
      event.clientY;

    isDraggingTab =
      false;

    try {
      button.setPointerCapture(
        event.pointerId
      );
    } catch (error) {
      // Pointer capture is optional.
    }
  }

  function handleTabPointerMove(
    event
  ) {
    if (
      !draggedTab ||
      !draggedNoteId
    ) {
      return;
    }

    const distanceX =
      Math.abs(
        event.clientX -
          dragStartX
      );

    const distanceY =
      Math.abs(
        event.clientY -
          dragStartY
      );

    if (
      !isDraggingTab &&
      distanceX <
        DRAG_THRESHOLD &&
      distanceY <
        DRAG_THRESHOLD
    ) {
      return;
    }

    if (!isDraggingTab) {
      isDraggingTab =
        true;

      suppressNextClick =
        true;

      document.body.style.userSelect =
        "none";

      draggedTab.classList.add(
        "is-dragging"
      );
    }

    reorderTabAtPointer(
      event.clientX
    );
  }

  function handleTabPointerUp(
    event
  ) {
    if (!draggedTab) {
      return;
    }

    if (isDraggingTab) {
      reorderTabAtPointer(
        event.clientX
      );

      saveTabOrderFromDOM();
    }

    finishTabDrag(
      event
    );
  }

  function handleTabPointerCancel(
    event
  ) {
    finishTabDrag(
      event
    );
  }

  function finishTabDrag(
    event
  ) {
    if (draggedTab) {
      draggedTab.classList.remove(
        "is-dragging"
      );

      try {
        event.currentTarget.releasePointerCapture(
          event.pointerId
        );
      } catch (error) {
        // Pointer capture may already be released.
      }
    }

    document.body.style.userSelect =
      "";

    draggedTab = null;
    draggedNoteId = "";
    dragStartX = 0;
    dragStartY = 0;
    isDraggingTab = false;
  }

  /* =========================================================
     LIVE TAB REORDERING
     ========================================================= */

  function reorderTabAtPointer(
    pointerX
  ) {
    if (
      !workTabs ||
      !draggedTab
    ) {
      return;
    }

    const tabs =
      Array.from(
        workTabs.querySelectorAll(
          ".note-tab"
        )
      ).filter(
        (tab) =>
          tab !== draggedTab
      );

    if (!tabs.length) {
      return;
    }

    let targetTab =
      null;

    for (const tab of tabs) {
      const rect =
        tab.getBoundingClientRect();

      const center =
        rect.left +
        rect.width / 2;

      if (
        pointerX <
        center
      ) {
        targetTab =
          tab;

        break;
      }
    }

    if (targetTab) {
      workTabs.insertBefore(
        draggedTab,
        targetTab
      );

      return;
    }

    const addButton =
      workTabs.querySelector(
        ".add-tab-btn"
      );

    if (addButton) {
      workTabs.insertBefore(
        draggedTab,
        addButton
      );
    } else {
      workTabs.appendChild(
        draggedTab
      );
    }
  }

  /* =========================================================
     SAVE TAB ORDER
     ========================================================= */

  function saveTabOrderFromDOM() {
    if (!workTabs) {
      return;
    }

    const visibleIds =
      Array.from(
        workTabs.querySelectorAll(
          ".note-tab"
        )
      ).map(
        (tab) =>
          tab.dataset.noteId
      );

    if (!visibleIds.length) {
      return;
    }

    const searchTerm =
      tabSearch
        ? tabSearch.value
            .trim()
            .toLowerCase()
        : "";

    if (!searchTerm) {
      const noteMap =
        new Map(
          state.notes.map(
            (note) => [
              note.id,
              note
            ]
          )
        );

      state.notes =
        visibleIds
          .map(
            (id) =>
              noteMap.get(
                id
              )
          )
          .filter(Boolean);

      saveLocalState();

      /*
       * The current database schema doesn't
       * have a tab-order column yet.
       *
       * For now, the order remains in localStorage.
       */
      return;
    }

    const visibleSet =
      new Set(
        visibleIds
      );

    const reorderedVisibleNotes =
      visibleIds
        .map(
          (id) =>
            state.notes.find(
              (note) =>
                note.id ===
                id
            )
        )
        .filter(Boolean);

    let visibleIndex =
      0;

    state.notes =
      state.notes.map(
        (note) => {
          if (
            visibleSet.has(
              note.id
            )
          ) {
            const replacement =
              reorderedVisibleNotes[
                visibleIndex
              ];

            visibleIndex++;

            return (
              replacement ||
              note
            );
          }

          return note;
        }
      );

    saveLocalState();
  }

  /* =========================================================
     NOTE ACTIVATION
     ========================================================= */

  function activateNote(
    noteId
  ) {
    if (
      !state.notes.some(
        (note) =>
          note.id === noteId
      )
    ) {
      return;
    }

    saveCurrentEditor();

    state.activeId =
      noteId;

    saveLocalState();

    render();
  }

  /* =========================================================
     DOCUMENT
     ========================================================= */

  function renderDocument() {
    const note =
      getActiveNote();

    if (!note) {
      if (documentWorkspace) {
        documentWorkspace.hidden =
          true;
      }

      if (emptyWorkspace) {
        emptyWorkspace.hidden =
          false;
      }

      return;
    }

    if (documentWorkspace) {
      documentWorkspace.hidden =
        false;
    }

    if (emptyWorkspace) {
      emptyWorkspace.hidden =
        true;
    }

    if (noteTitle) {
      noteTitle.value =
        note.title ||
        "Untitled Note";
    }

    if (noteDate) {
      noteDate.value =
        note.date ||
        getToday();
    }

    if (noteEditor) {
      noteEditor.innerHTML =
        note.content || "";
    }

    updateSaveIndicator(
      isCloudLoading
        ? "Loading..."
        : "Saved"
    );
  }

  /* =========================================================
     SAVE CURRENT NOTE
     ========================================================= */

  function saveCurrentEditor() {
    const note =
      getActiveNote();

    if (!note) {
      return null;
    }

    if (noteTitle) {
      note.title =
        noteTitle.value.trim() ||
        "Untitled Note";
    }

    if (noteDate) {
      note.date =
        noteDate.value ||
        getToday();
    }

    if (noteEditor) {
      note.content =
        noteEditor.innerHTML;
    }

    note.updatedAt =
      Date.now();

    saveLocalState();

    return note;
  }

  function scheduleSave() {
    updateSaveIndicator(
      "Saving..."
    );

    clearTimeout(
      saveTimer
    );

    saveTimer =
      setTimeout(
        async () => {
          const note =
            saveCurrentEditor();

          if (!note) {
            return;
          }

          updateActiveTab();

          if (
            supabaseClient
          ) {
            const success =
              await saveNoteToCloud(
                note
              );

            updateSaveIndicator(
              success
                ? "Saved"
                : "Local backup"
            );
          } else {
            updateSaveIndicator(
              "Saved locally"
            );
          }
        },
        500
      );
  }

  async function saveImmediately() {
    clearTimeout(
      saveTimer
    );

    const note =
      saveCurrentEditor();

    if (!note) {
      return;
    }

    updateActiveTab();

    if (!supabaseClient) {
      updateSaveIndicator(
        "Saved locally"
      );

      return;
    }

    updateSaveIndicator(
      "Saving..."
    );

    const success =
      await saveNoteToCloud(
        note
      );

    updateSaveIndicator(
      success
        ? "Saved"
        : "Local backup"
    );
  }

  function updateSaveIndicator(
    message
  ) {
    if (saveIndicator) {
      saveIndicator.textContent =
        message;
    }
  }

  /* =========================================================
     UPDATE ACTIVE TAB
     ========================================================= */

  function updateActiveTab() {
    if (!workTabs) {
      return;
    }

    const activeNote =
      getActiveNote();

    if (!activeNote) {
      return;
    }

    const activeTab =
      workTabs.querySelector(
        `.note-tab[data-note-id="${activeNote.id}"]`
      );

    if (!activeTab) {
      return;
    }

    /*
     * Remove active state from every tab
     * before applying it to the correct one.
     */
    workTabs
      .querySelectorAll(
        ".note-tab"
      )
      .forEach(
        (tab) => {
          tab.classList.toggle(
            "active",
            tab ===
              activeTab
          );
        }
      );

    const title =
      activeTab.querySelector(
        ".tab-title"
      );

    const date =
      activeTab.querySelector(
        ".tab-date"
      );

    const tabMain =
      activeTab.querySelector(
        ".tab-main"
      );

    const closeButton =
      activeTab.querySelector(
        ".tab-close"
      );

    if (title) {
      title.textContent =
        activeNote.title ||
        "Untitled Note";
    }

    if (date) {
      date.textContent =
        activeNote.date ||
        "";
    }

    if (tabMain) {
      tabMain.setAttribute(
        "aria-label",
        `Open ${
          activeNote.title ||
          "Untitled Note"
        }`
      );
    }

    if (closeButton) {
      closeButton.setAttribute(
        "aria-label",
        `Delete ${
          activeNote.title ||
          "note"
        }`
      );
    }
  }

  /* =========================================================
     SELECTION HANDLING
     ========================================================= */

  function saveSelection() {
    if (!noteEditor) {
      return;
    }

    const selection =
      window.getSelection();

    if (
      !selection ||
      selection.rangeCount ===
        0
    ) {
      return;
    }

    const range =
      selection.getRangeAt(
        0
      );

    if (
      noteEditor.contains(
        range.commonAncestorContainer
      )
    ) {
      savedSelection =
        range.cloneRange();
    }
  }

  function restoreSelection() {
    if (!savedSelection) {
      return false;
    }

    const selection =
      window.getSelection();

    if (!selection) {
      return false;
    }

    try {
      selection.removeAllRanges();

      selection.addRange(
        savedSelection
      );

      return true;
    } catch (error) {
      savedSelection =
        null;

      return false;
    }
  }

  /* =========================================================
     FORMATTING
     ========================================================= */

  function formatText(
    command,
    value = null
  ) {
    if (!noteEditor) {
      return;
    }

    noteEditor.focus();

    restoreSelection();

    try {
      document.execCommand(
        command,
        false,
        value
      );
    } catch (error) {
      console.error(
        "Formatting command failed:",
        command,
        error
      );
    }

    saveSelection();

    scheduleSave();
  }

  /* =========================================================
     TABLES
     ========================================================= */

  function getSelectedTableCell() {
    if (!noteEditor) {
      return null;
    }

    const selection =
      window.getSelection();

    if (
      !selection ||
      selection.rangeCount ===
        0
    ) {
      return null;
    }

    let node =
      selection.anchorNode;

    if (
      node &&
      node.nodeType ===
        Node.TEXT_NODE
    ) {
      node =
        node.parentElement;
    }

    return (
      node?.closest(
        ".note-table td, .note-table th"
      ) || null
    );
  }

  function getActiveTable() {
    const cell =
      getSelectedTableCell();

    return cell
      ? cell.closest(
          "table"
        )
      : null;
  }

  function createTable() {
    if (!noteEditor) {
      return;
    }

    const rowsInput =
      window.prompt(
        "How many rows?",
        "3"
      );

    if (
      rowsInput === null
    ) {
      return;
    }

    const columnsInput =
      window.prompt(
        "How many columns?",
        "3"
      );

    if (
      columnsInput === null
    ) {
      return;
    }

    const rows =
      Math.max(
        1,
        Math.min(
          20,
          parseInt(
            rowsInput,
            10
          ) || 1
        )
      );

    const columns =
      Math.max(
        1,
        Math.min(
          12,
          parseInt(
            columnsInput,
            10
          ) || 1
        )
      );

    noteEditor.focus();

    restoreSelection();

    const wrapper =
      document.createElement(
        "div"
      );

    wrapper.className =
      "note-table-wrapper";

    const table =
      document.createElement(
        "table"
      );

    table.className =
      "note-table";

    const tbody =
      document.createElement(
        "tbody"
      );

    for (
      let rowIndex = 0;
      rowIndex < rows;
      rowIndex++
    ) {
      const tr =
        document.createElement(
          "tr"
        );

      for (
        let columnIndex = 0;
        columnIndex < columns;
        columnIndex++
      ) {
        const td =
          document.createElement(
            "td"
          );

        td.contentEditable =
          "true";

        td.innerHTML =
          "&nbsp;";

        tr.appendChild(
          td
        );
      }

      tbody.appendChild(
        tr
      );
    }

    table.appendChild(
      tbody
    );

    wrapper.appendChild(
      table
    );

    const selection =
      window.getSelection();

    if (
      selection &&
      selection.rangeCount >
        0
    ) {
      const range =
        selection.getRangeAt(
          0
        );

      if (
        noteEditor.contains(
          range.commonAncestorContainer
        )
      ) {
        range.deleteContents();

        range.insertNode(
          wrapper
        );

        const paragraph =
          document.createElement(
            "p"
          );

        paragraph.innerHTML =
          "<br>";

        wrapper.after(
          paragraph
        );

        placeCaretInside(
          paragraph
        );
      } else {
        noteEditor.appendChild(
          wrapper
        );

        const paragraph =
          document.createElement(
            "p"
          );

        paragraph.innerHTML =
          "<br>";

        noteEditor.appendChild(
          paragraph
        );

        placeCaretInside(
          paragraph
        );
      }
    } else {
      noteEditor.appendChild(
        wrapper
      );

      const paragraph =
        document.createElement(
          "p"
        );

      paragraph.innerHTML =
        "<br>";

      noteEditor.appendChild(
        paragraph
      );

      placeCaretInside(
        paragraph
      );
    }

    scheduleSave();
  }

  function placeCaretInside(
    element
  ) {
    const range =
      document.createRange();

    const selection =
      window.getSelection();

    range.selectNodeContents(
      element
    );

    range.collapse(
      false
    );

    selection.removeAllRanges();

    selection.addRange(
      range
    );

    savedSelection =
      range.cloneRange();
  }

  /* =========================================================
     TABLE CONTROLS
     ========================================================= */

  function addTableRow() {
    const table =
      getActiveTable();

    if (!table) {
      return;
    }

    const body =
      table.tBodies[0] ||
      table.createTBody();

    const columnCount =
      table.rows[0]
        ? table.rows[0]
            .cells.length
        : 1;

    const row =
      body.insertRow(-1);

    for (
      let index = 0;
      index < columnCount;
      index++
    ) {
      const cell =
        row.insertCell();

      cell.contentEditable =
        "true";

      cell.innerHTML =
        "&nbsp;";
    }

    scheduleSave();
  }

  function addTableColumn() {
    const table =
      getActiveTable();

    if (!table) {
      return;
    }

    Array.from(
      table.rows
    ).forEach(
      (row) => {
        const cell =
          row.insertCell(-1);

        cell.contentEditable =
          "true";

        cell.innerHTML =
          "&nbsp;";
      }
    );

    scheduleSave();
  }

  function deleteTableRow() {
    const cell =
      getSelectedTableCell();

    if (!cell) {
      return;
    }

    const row =
      cell.parentElement;

    const table =
      row.closest(
        "table"
      );

    if (!table) {
      return;
    }

    if (
      table.rows.length <= 1
    ) {
      return;
    }

    row.remove();

    scheduleSave();
  }

  function deleteTableColumn() {
    const cell =
      getSelectedTableCell();

    if (!cell) {
      return;
    }

    const row =
      cell.parentElement;

    const table =
      row.closest(
        "table"
      );

    if (!table) {
      return;
    }

    const columnIndex =
      cell.cellIndex;

    const columnCount =
      table.rows[0]
        ? table.rows[0]
            .cells.length
        : 0;

    if (
      columnCount <= 1
    ) {
      return;
    }

    Array.from(
      table.rows
    ).forEach(
      (tableRow) => {
        if (
          tableRow.cells[
            columnIndex
          ]
        ) {
          tableRow.deleteCell(
            columnIndex
          );
        }
      }
    );

    scheduleSave();
  }

  function updateTableButtons() {
    const hasTable =
      !!getActiveTable();

    if (addRow) {
      addRow.disabled =
        !hasTable;
    }

    if (addColumn) {
      addColumn.disabled =
        !hasTable;
    }

    if (deleteRow) {
      deleteRow.disabled =
        !hasTable;
    }

    if (deleteColumn) {
      deleteColumn.disabled =
        !hasTable;
    }
  }

  /* =========================================================
     TABLE KEYBOARD NAVIGATION
     ========================================================= */

  function handleTableKeydown(
    event
  ) {
    const cell =
      event.target.closest?.(
        ".note-table td, .note-table th"
      );

    if (!cell) {
      return;
    }

    const table =
      cell.closest(
        "table"
      );

    if (!table) {
      return;
    }

    const cells =
      Array.from(
        table.querySelectorAll(
          "td, th"
        )
      );

    const currentIndex =
      cells.indexOf(
        cell
      );

    if (
      currentIndex === -1
    ) {
      return;
    }

    /* =====================================================
       TAB
       ===================================================== */

    if (
      event.key === "Tab"
    ) {
      event.preventDefault();

      let nextIndex =
        event.shiftKey
          ? currentIndex - 1
          : currentIndex + 1;

      if (
        !event.shiftKey &&
        nextIndex >=
          cells.length
      ) {
        const body =
          table.tBodies[0] ||
          table.createTBody();

        const columnCount =
          table.rows[0]
            ? table.rows[0]
                .cells.length
            : 1;

        const newRow =
          body.insertRow(-1);

        const newCells = [];

        for (
          let index = 0;
          index < columnCount;
          index++
        ) {
          const newCell =
            newRow.insertCell();

          newCell.contentEditable =
            "true";

          newCell.innerHTML =
            "&nbsp;";

          newCells.push(
            newCell
          );
        }

        const updatedCells =
          Array.from(
            table.querySelectorAll(
              "td, th"
            )
          );

        const firstNewCell =
          updatedCells[
            updatedCells.length -
              newCells.length
          ];

        if (firstNewCell) {
          focusCell(
            firstNewCell
          );
        }

        scheduleSave();

        return;
      }

      if (
        nextIndex >= 0 &&
        nextIndex <
          cells.length
      ) {
        focusCell(
          cells[nextIndex]
        );
      }

      return;
    }

    /* =====================================================
       ENTER
       ===================================================== */

    if (
      event.key === "Enter"
    ) {
      event.preventDefault();

      const columnIndex =
        cell.cellIndex;

      const row =
        cell.parentElement;

      const nextRow =
        row.nextElementSibling;

      if (nextRow) {
        const nextCell =
          nextRow.cells[
            columnIndex
          ];

        if (nextCell) {
          focusCell(
            nextCell
          );

          return;
        }
      }

      const body =
        table.tBodies[0] ||
        table.createTBody();

      const columnCount =
        table.rows[0]
          ? table.rows[0]
              .cells.length
          : 1;

      const newRow =
        body.insertRow(-1);

      for (
        let index = 0;
        index < columnCount;
        index++
      ) {
        const newCell =
          newRow.insertCell();

        newCell.contentEditable =
          "true";

        newCell.innerHTML =
          "&nbsp;";
      }

      const newCell =
        newRow.cells[
          columnIndex
        ];

      if (newCell) {
        focusCell(
          newCell
        );
      }

      scheduleSave();
    }
  }

  function focusCell(
    cell
  ) {
    if (!cell) {
      return;
    }

    cell.focus();

    const range =
      document.createRange();

    const selection =
      window.getSelection();

    range.selectNodeContents(
      cell
    );

    range.collapse(
      false
    );

    selection.removeAllRanges();

    selection.addRange(
      range
    );

    savedSelection =
      range.cloneRange();
  }

  /* =========================================================
     DELETE NOTE
     ========================================================= */

  async function deleteNoteById(
    noteId
  ) {
    const note =
      state.notes.find(
        (item) =>
          item.id === noteId
      );

    if (!note) {
      return;
    }

    const confirmed =
      window.confirm(
        `Delete "${
          note.title ||
          "Untitled Note"
        }"?`
      );

    if (!confirmed) {
      return;
    }

    const deletedIndex =
      state.notes.findIndex(
        (item) =>
          item.id === noteId
      );

    state.notes =
      state.notes.filter(
        (item) =>
          item.id !== noteId
      );

    if (
      state.activeId ===
      noteId
    ) {
      if (
        state.notes.length
      ) {
        const nextIndex =
          Math.min(
            deletedIndex,
            state.notes.length -
              1
          );

        state.activeId =
          state.notes[
            nextIndex
          ].id;
      } else {
        state.activeId =
          "";
      }
    }

    saveLocalState();
    render();

    updateSaveIndicator(
      "Saving..."
    );

    if (supabaseClient) {
      const success =
        await deleteNoteFromCloud(
          noteId
        );

      updateSaveIndicator(
        success
          ? "Saved"
          : "Local backup"
      );
    }

    if (
      !state.notes.length
    ) {
      createNote();
    }
  }

  /* =========================================================
     DUPLICATE NOTE
     ========================================================= */

  function duplicateCurrentNote() {
    const current =
      getActiveNote();

    if (!current) {
      return;
    }

    saveCurrentEditor();

    const now =
      Date.now();

    const duplicate = {
      ...current,

      id:
        generateId(),

      title:
        `${
          current.title ||
          "Untitled Note"
        } Copy`,

      createdAt:
        now,

      updatedAt:
        now
    };

    const currentIndex =
      state.notes.findIndex(
        (note) =>
          note.id ===
          current.id
      );

    state.notes.splice(
      currentIndex + 1,
      0,
      duplicate
    );

    state.activeId =
      duplicate.id;

    saveLocalState();

    render();

    /*
     * Save duplicate to cloud.
     */
    saveNoteToCloud(
      duplicate
    );

    focusNewNoteTitle();
  }

  /* =========================================================
     EVENT BINDINGS
     ========================================================= */

  function bindEvents() {
    /* =====================================================
       NEW NOTE
       ===================================================== */

    if (newWorkTab) {
      newWorkTab.addEventListener(
        "click",
        createNote
      );
    }

    if (
      addTabButton &&
      addTabButton !==
        newWorkTab
    ) {
      addTabButton.addEventListener(
        "click",
        createNote
      );
    }

    /* =====================================================
       TITLE
       ===================================================== */

    if (noteTitle) {
      noteTitle.addEventListener(
        "input",
        () => {
          scheduleSave();
        }
      );
    }

    /* =====================================================
       DATE
       ===================================================== */

    if (noteDate) {
      noteDate.addEventListener(
        "change",
        () => {
          scheduleSave();
        }
      );
    }

    /* =====================================================
       EDITOR
       ===================================================== */

    if (noteEditor) {
      noteEditor.addEventListener(
        "input",
        () => {
          saveSelection();

          scheduleSave();

          updateTableButtons();
        }
      );

      noteEditor.addEventListener(
        "keyup",
        () => {
          saveSelection();

          updateTableButtons();
        }
      );

      noteEditor.addEventListener(
        "mouseup",
        () => {
          saveSelection();

          updateTableButtons();
        }
      );

      noteEditor.addEventListener(
        "focusin",
        (event) => {
          if (
            event.target.closest?.(
              ".note-table td, .note-table th"
            )
          ) {
            saveSelection();

            updateTableButtons();
          }
        }
      );

      noteEditor.addEventListener(
        "click",
        (event) => {
          if (
            event.target.closest?.(
              ".note-table td, .note-table th"
            )
          ) {
            saveSelection();

            updateTableButtons();
          }
        }
      );

      noteEditor.addEventListener(
        "keydown",
        handleTableKeydown
      );

      noteEditor.addEventListener(
        "blur",
        () => {
          saveSelection();

          scheduleSave();
        }
      );
    }

    /* =====================================================
       FORMATTING
       ===================================================== */

    document
      .querySelectorAll(
        "[data-command]"
      )
      .forEach(
        (button) => {
          button.addEventListener(
            "mousedown",
            (event) => {
              event.preventDefault();

              saveSelection();
            }
          );

          button.addEventListener(
            "click",
            (event) => {
              event.preventDefault();

              const command =
                button.dataset.command;

              const value =
                button.dataset.value ||
                null;

              formatText(
                command,
                value
              );
            }
          );
        }
      );

    /* =====================================================
       INSERT TABLE
       ===================================================== */

    if (insertTable) {
      insertTable.addEventListener(
        "mousedown",
        (event) => {
          event.preventDefault();

          saveSelection();
        }
      );

      insertTable.addEventListener(
        "click",
        createTable
      );
    }

    /* =====================================================
       TABLE BUTTONS
       ===================================================== */

    if (addRow) {
      addRow.addEventListener(
        "click",
        addTableRow
      );
    }

    if (addColumn) {
      addColumn.addEventListener(
        "click",
        addTableColumn
      );
    }

    if (deleteRow) {
      deleteRow.addEventListener(
        "click",
        deleteTableRow
      );
    }

    if (deleteColumn) {
      deleteColumn.addEventListener(
        "click",
        deleteTableColumn
      );
    }

    /* =====================================================
       SAVE
       ===================================================== */

    if (saveNoteButton) {
      saveNoteButton.addEventListener(
        "click",
        async () => {
          const originalText =
            saveNoteButton.textContent;

          saveNoteButton.textContent =
            "Saving...";

          await saveImmediately();

          saveNoteButton.textContent =
            "Saved";

          setTimeout(
            () => {
              if (
                saveNoteButton
              ) {
                saveNoteButton.textContent =
                  originalText ||
                  "Save Note";
              }
            },
            1200
          );
        }
      );
    }

    /* =====================================================
       DUPLICATE
       ===================================================== */

    if (duplicateNote) {
      duplicateNote.addEventListener(
        "click",
        duplicateCurrentNote
      );
    }

    /* =====================================================
       DELETE
       ===================================================== */

    if (deleteNote) {
      deleteNote.addEventListener(
        "click",
        () => {
          if (
            state.activeId
          ) {
            deleteNoteById(
              state.activeId
            );
          }
        }
      );
    }

    /* =====================================================
       SEARCH
       ===================================================== */

    if (tabSearch) {
      tabSearch.addEventListener(
        "input",
        renderTabs
      );
    }

    if (clearSearch) {
      clearSearch.addEventListener(
        "click",
        () => {
          if (tabSearch) {
            tabSearch.value =
              "";
          }

          renderTabs();

          if (tabSearch) {
            tabSearch.focus();
          }
        }
      );
    }

    /* =====================================================
       KEYBOARD SAVE
       ===================================================== */

    document.addEventListener(
      "keydown",
      (event) => {
        if (
          (event.ctrlKey ||
            event.metaKey) &&
          event.key.toLowerCase() ===
            "s"
        ) {
          event.preventDefault();

          saveImmediately();
        }
      }
    );
  }
})();