const form = document.getElementById('loginForm');
const message = document.getElementById('loginMessage');
const button = document.getElementById('loginButton');

async function checkExistingSession() {
  try {
    if (!window.SAE_SUPABASE) throw new Error('No se ha cargado la configuración de Supabase.');
    const { data, error } = await window.SAE_SUPABASE.auth.getSession();

    if (!error && data && data.session) {
      window.location.replace('./index.html');
    }
  } catch (error) {
    message.textContent = 'No se ha podido conectar con el servicio de acceso. Revisa la configuración e inténtalo de nuevo.';
  }
}

checkExistingSession();

form.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = '';
  button.disabled = true;
  button.textContent = 'Comprobando acceso…';

  try {
    if (!window.SAE_SUPABASE) throw new Error('No se ha cargado la configuración de Supabase.');

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    const { error } = await window.SAE_SUPABASE.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      message.textContent = 'No se ha podido iniciar sesión. Comprueba el correo y la contraseña.';
      return;
    }

    window.location.replace('./index.html');
  } catch (error) {
    message.textContent = 'No se ha podido conectar. Comprueba la conexión e inténtalo de nuevo.';
  } finally {
    button.disabled = false;
    button.textContent = 'Iniciar sesión';
  }
});
