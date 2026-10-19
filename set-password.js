const passwordForm = document.getElementById('passwordForm');
const pageMessage = document.getElementById('pageMessage');
const passwordMessage = document.getElementById('loginMessage');
const saveButton = document.getElementById('savePasswordButton');

function showPageMessage(text) {
  pageMessage.textContent = text;
  pageMessage.hidden = false;
}

function showPasswordMessage(text, success = false) {
  passwordMessage.textContent = text;
  passwordMessage.classList.toggle('success', success);
}

async function preparePasswordForm() {
  try {
    const authParams = new URLSearchParams(window.location.hash.slice(1));
    const errorCode = authParams.get('error_code') || new URLSearchParams(window.location.search).get('error_code');
    const errorDescription = authParams.get('error_description') || new URLSearchParams(window.location.search).get('error_description');

    if (errorCode || errorDescription) {
      passwordForm.hidden = true;
      showPageMessage(
        errorCode === 'otp_expired'
          ? 'Esta invitación ha caducado o ya se ha utilizado. Pide que te envíen una nueva.'
          : 'No se ha podido validar el enlace. Pide que te envíen una nueva invitación.'
      );
      return;
    }

    if (!window.SAE_SUPABASE) {
      throw new Error('No se ha cargado la configuración de acceso.');
    }

    const { data, error } = await window.SAE_SUPABASE.auth.getSession();
    if (error) throw error;

    if (!data || !data.session || !data.session.user) {
      passwordForm.hidden = true;
      showPageMessage('No se ha podido validar la invitación. Abre el enlace del correo de nuevo o pide que te envíen otra invitación.');
      return;
    }

    pageMessage.hidden = true;
    passwordForm.hidden = false;
    showPasswordMessage('Enlace validado. Ya puedes crear tu contraseña.');
  } catch (error) {
    console.error('Error al validar la invitación:', error);
    passwordForm.hidden = true;
    showPageMessage('No se ha podido conectar con el servicio de acceso. Comprueba la conexión e inténtalo de nuevo.');
  }
}

passwordForm.addEventListener('submit', async event => {
  event.preventDefault();

  const password = document.getElementById('password').value;
  const confirmation = document.getElementById('passwordConfirm').value;

  if (password.length < 8) {
    showPasswordMessage('La contraseña debe tener al menos 8 caracteres.');
    return;
  }

  if (password !== confirmation) {
    showPasswordMessage('Las contraseñas no coinciden.');
    return;
  }

  saveButton.disabled = true;
  saveButton.textContent = 'Guardando…';
  showPasswordMessage('');

  try {
    const { data, error } = await window.SAE_SUPABASE.auth.updateUser({ password });
    if (error) throw error;
    if (!data || !data.user) throw new Error('No se ha confirmado el cambio de contraseña.');

    showPasswordMessage('Contraseña creada correctamente. Entrando en SAE Spotter…', true);
    window.location.replace('./index.html');
  } catch (error) {
    console.error('No se pudo guardar la contraseña:', error);
    showPasswordMessage('No se ha podido guardar la contraseña. Comprueba el enlace y vuelve a intentarlo.');
    saveButton.disabled = false;
    saveButton.textContent = 'Guardar contraseña';
  }
});

preparePasswordForm();
