(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./service-worker.js').catch(function (error) {
        console.warn('No se pudo registrar el modo de aplicación:', error);
      });
    });
  }

  var installPrompt = null;
  function addInstallButton() {
    if (document.getElementById('installAppButton') || !document.body) return;
    var button = document.createElement('button');
    button.id = 'installAppButton';
    button.type = 'button';
    button.textContent = '＋ Instalar aplicación';
    button.style.cssText = [
      'position:fixed','right:14px','bottom:14px','z-index:9999',
      'border:0','border-radius:999px','padding:12px 17px',
      'background:#17212b','color:#fff','font:700 13px system-ui,sans-serif',
      'box-shadow:0 6px 22px #17212b33','cursor:pointer','display:none'
    ].join(';');
    button.addEventListener('click', async function () {
      if (!installPrompt) return;
      button.disabled = true;
      try {
        installPrompt.prompt();
        await installPrompt.userChoice;
      } catch (error) {
        console.warn('La instalación no se pudo abrir:', error);
      } finally {
        installPrompt = null;
        button.remove();
      }
    });
    document.body.appendChild(button);
    return button;
  }

  var installButton = null;
  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installPrompt = event;
    installButton = addInstallButton();
    if (installButton) installButton.style.display = 'block';
  });
  window.addEventListener('appinstalled', function () {
    installPrompt = null;
    if (installButton) installButton.remove();
  });
})();