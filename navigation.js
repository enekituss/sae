(function () {
  // En la portada, deja una entrada de historial de seguridad. Atrás desde
  // cualquier página vuelve con normalidad; estando en la portada no sale
  // de la aplicación ni vuelve al formulario de acceso.
  function installHomeBackGuard() {
    var path = window.location.pathname.replace(/\/+$/, '');
    var isHome = path === '' || path.endsWith('/index.html');
    if (!isHome) return;
    if (!history.state || !history.state.__saeHomeBoundary) {
      history.pushState({ __saeHomeBoundary: true }, '', window.location.href);
    }
    window.addEventListener('popstate', function () {
      history.pushState({ __saeHomeBoundary: true }, '', window.location.href);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installHomeBackGuard, { once: true });
  } else {
    installHomeBackGuard();
  }
})();