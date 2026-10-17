(async function protectPage() {
  try {
    if (!window.SAE_SUPABASE) {
      window.location.replace('./login.html');
      return;
    }

    const { data, error } = await window.SAE_SUPABASE.auth.getSession();

    if (error || !data || !data.session) {
      window.location.replace('./login.html');
      return;
    }

    document.documentElement.classList.remove('auth-check');

    function addLogoutButton() {
      const header = document.querySelector('.topbar');
      if (!header || document.getElementById('logoutButton')) return;

      const button = document.createElement('button');
      button.id = 'logoutButton';
      button.type = 'button';
      button.textContent = 'Cerrar sesión';
      button.style.cssText = [
        'padding:10px 14px',
        'border:0',
        'border-radius:9px',
        'background:#17212b',
        'color:white',
        'font-weight:700',
        'cursor:pointer',
        'flex-shrink:0'
      ].join(';');

      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Cerrando sesión…';

        try {
          const { error: signOutError } = await window.SAE_SUPABASE.auth.signOut();
          if (signOutError) throw signOutError;
          window.location.replace('./login.html');
        } catch (error) {
          button.disabled = false;
          button.textContent = 'Cerrar sesión';
          alert('No se ha podido cerrar la sesión. Inténtalo de nuevo.');
        }
      });

      header.appendChild(button);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', addLogoutButton, { once: true });
    } else {
      addLogoutButton();
    }
  } catch (error) {
    window.location.replace('./login.html');
  }
})();
