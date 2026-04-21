/********************************************
 * FILE: server-save.js
 *
 * Server-side file saving with an in-browser folder picker.
 * Uses the Julia server's list_directory / save_file WebSocket
 * messages so the user can save to any folder in the workspace.
 *
 * Public API (called by save buttons):
 *   saveViaServer(content, defaultFilename)
 ********************************************/

(function() {
  'use strict';

  // ---- Internal state ------------------------------------------------
  var _pendingContent  = '';
  var _pendingExtraFiles = [];   // [{content, filename}] saved alongside the primary
  var _pendingFilename = '';
  var _currentPath     = '';   // absolute path currently shown

  // ---- Open the folder picker ----------------------------------------

  /**
   * Show the folder picker modal and prepare a server-side save.
   * @param {string} content         Text content to write
   * @param {string} defaultFilename Suggested filename
   */
  window.saveViaServer = function(content, defaultFilename) {
    if (!window.aeroClient || !window.aeroClient.isConnected()) {
      // Fall back to browser download when server is not available
      _browserDownload(content, defaultFilename);
      return;
    }

    _pendingContent  = content;
    _pendingFilename = defaultFilename || 'output.txt';
    _pendingExtraFiles = [];

    // Allow callers to queue extra files AFTER this call returns but
    // BEFORE the user clicks Save (synchronous — runs before the modal
    // event loop).  Use: window.addPendingExtraFile(filename, content).

    // Show modal
    var modal = document.getElementById('folderPickerModal');
    if (!modal) { _browserDownload(content, defaultFilename); return; }

    document.getElementById('fpFilename').value = _pendingFilename;
    _clearStatus();
    modal.style.display = 'block';

    // Load workspace root
    window.aeroClient.listDirectory('');
  };

  window.addPendingExtraFile = function(filename, content) {
    _pendingExtraFiles.push({ filename: filename, content: content });
  };

  // ---- Directory listing response ------------------------------------

  function _onDirectoryListing(msg) {
    if (msg.error) {
      _setStatus('Error: ' + msg.error, true);
      return;
    }
    _currentPath = msg.path || '';
    _renderListing(msg);
  }

  // ---- Render the listing in the modal -------------------------------

  function _renderListing(msg) {
    // Update path display
    document.getElementById('fpCurrentPath').value = _currentPath;

    // Up button: enabled unless at filesystem root
    var upBtn = document.getElementById('fpUpBtn');
    var isRoot = !msg.parent || msg.parent === _currentPath;
    upBtn.disabled = isRoot;

    // Populate entry list
    var list = document.getElementById('fpEntryList');
    list.innerHTML = '';

    var entries = msg.entries || [];
    if (entries.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'fp-empty';
      empty.textContent = '(empty folder)';
      list.appendChild(empty);
      return;
    }

    entries.forEach(function(entry) {
      var item = document.createElement('div');
      item.className = entry.is_dir ? 'fp-entry fp-dir' : 'fp-entry fp-file';

      var icon = document.createElement('span');
      icon.className = 'fp-icon';
      icon.textContent = entry.is_dir ? '\uD83D\uDCC1' : '\uD83D\uDCC4';  // 📁 📄

      var name = document.createElement('span');
      name.className = 'fp-name';
      name.textContent = entry.name;

      item.appendChild(icon);
      item.appendChild(name);

      if (entry.is_dir) {
        item.title = 'Open: ' + entry.path;
        item.addEventListener('click', function() {
          _clearStatus();
          window.aeroClient.listDirectory(entry.path);
        });
      }

      list.appendChild(item);
    });
  }

  // ---- File saved response -------------------------------------------

  function _onFileSaved(msg) {
    if (msg.success) {
      _setStatus('\u2705 Saved: ' + (msg.path || ''), false);
      setTimeout(function() {
        var modal = document.getElementById('folderPickerModal');
        if (modal) modal.style.display = 'none';
      }, 1800);
    } else {
      _setStatus('\u274C Save failed: ' + (msg.error || 'unknown error'), true);
    }
  }

  // ---- Status helpers ------------------------------------------------

  function _setStatus(text, isError) {
    var el = document.getElementById('fpStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#e74c3c' : '#27ae60';
  }

  function _clearStatus() {
    var el = document.getElementById('fpStatus');
    if (el) { el.textContent = ''; }
  }

  // ---- Browser download fallback -------------------------------------

  function _browserDownload(content, filename) {
    var blob = new Blob([content], { type: 'text/plain' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url;
    a.download = filename || 'output.txt';
    a.style.display = 'none';
    document.body.appendChild(a);
    setTimeout(function() {
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }

  // ---- Wire up modal buttons once DOM is ready ----------------------

  document.addEventListener('DOMContentLoaded', function() {

    // Register callbacks on the shared aeroClient
    // (aeroClient is created in analysis-setup.js which loads after this file,
    //  so we defer wiring until the first save request via a one-time check)
    var _callbacksWired = false;
    function _ensureCallbacks() {
      if (_callbacksWired) return;
      if (!window.aeroClient) return;
      window.aeroClient
        .onDirectoryListing(_onDirectoryListing)
        .onFileSaved(_onFileSaved);
      _callbacksWired = true;
    }

    // Override saveViaServer to ensure callbacks are wired first
    var _origSaveViaServer = window.saveViaServer;
    window.saveViaServer = function(content, defaultFilename) {
      _ensureCallbacks();
      _origSaveViaServer(content, defaultFilename);
    };

    // Up button
    var upBtn = document.getElementById('fpUpBtn');
    if (upBtn) {
      upBtn.addEventListener('click', function() {
        if (!_currentPath) return;
        _clearStatus();
        // Navigate to parent: get parent from last listing or compute it
        var parent = _currentPath.replace(/\/[^/]+\/?$/, '') || _currentPath;
        if (parent === _currentPath) return;
        window.aeroClient.listDirectory(parent);
      });
    }

    // Save button
    var saveBtn = document.getElementById('fpSaveBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function() {
        var filename = (document.getElementById('fpFilename').value || '').trim();
        if (!filename) { _setStatus('Please enter a filename.', true); return; }
        if (!_currentPath) { _setStatus('No folder selected.', true); return; }
        _setStatus('Saving\u2026', false);
        window.aeroClient.saveFile(_currentPath, filename, _pendingContent);
        // Save any extra files queued alongside the primary (e.g. the
        // linearized companion to a tabular export). Uses the same folder
        // selected in the modal — no second dialog needed.
        for (var i = 0; i < _pendingExtraFiles.length; i++) {
          var extra = _pendingExtraFiles[i];
          window.aeroClient.saveFile(_currentPath, extra.filename, extra.content);
        }
        _pendingExtraFiles = [];
      });
    }

    // Cancel button
    var cancelBtn = document.getElementById('fpCancelBtn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function() {
        document.getElementById('folderPickerModal').style.display = 'none';
      });
    }

    // Close (×) button
    var closeBtn = document.getElementById('fpCloseBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        document.getElementById('folderPickerModal').style.display = 'none';
      });
    }

    // Click outside modal → close
    var modal = document.getElementById('folderPickerModal');
    if (modal) {
      modal.addEventListener('click', function(e) {
        if (e.target === modal) modal.style.display = 'none';
      });
    }
  });

})();
