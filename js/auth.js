// ═══════════════════════════════════════════════
// auth.js — Register, Login, Logout, Session
// ═══════════════════════════════════════════════

async function doRegister() {
  const name  = val('regName').trim();
  const email = val('regEmail').trim().toLowerCase();
  const pass  = val('regPass');
  const pass2 = val('regPass2');
  const loc   = val('regLocation').trim();

  const err = document.getElementById('regError');
  const suc = document.getElementById('regSuccess');
  err.style.display = 'none';
  suc.style.display = 'none';

  if (!name || !email || !pass)
    return showErr(err, 'Please fill in all required fields.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return showErr(err, 'Invalid email address.');
  if (pass.length < 6)
    return showErr(err, 'Password must be at least 6 characters.');
  if (pass !== pass2)
    return showErr(err, 'Passwords do not match.');

  try {
    const { user } = await apiPost('/auth/register', {
      name, email, password: pass, location: loc,
      avatar: state.avatarDataURL || null,
    });
    state.currentUser = user;
    suc.style.display = 'block';
    suc.textContent   = '✅ Account created! Redirecting...';
    setTimeout(() => { window.location.href = 'index.html'; }, 1500);
  } catch (e) {
    let msg = e.message || 'Registration failed.';
    if (msg.includes('email-already-in-use')) msg = 'An account with this email already exists.';
    showErr(err, msg);
  }
}

async function doLogin() {
  const email = val('loginEmail').trim().toLowerCase();
  const pass  = val('loginPass');
  const err   = document.getElementById('loginError');
  err.style.display = 'none';

  if (!email || !pass) return showErr(err, 'Please fill in all fields.');

  try {
    const { user } = await apiPost('/auth/login', { email, password: pass });
    state.currentUser = user;
    updateNavUser();
    showToast('Welcome back, ' + user.name + '! 👋');
    setTimeout(() => { window.location.href = 'index.html'; }, 800);
  } catch (e) {
    let msg = e.message || 'Login failed.';
    if (msg.includes('user-not-found') || msg.includes('wrong-password') || msg.includes('invalid-credential'))
      msg = 'Invalid email or password.';
    showErr(err, msg);
  }
}

async function logout() {
  try { await apiPost('/auth/logout'); } catch (_) {}
  state.currentUser = null;
  updateNavUser();
  showToast('Signed out successfully');
  setTimeout(() => { window.location.href = 'index.html'; }, 800);
}

function requireLoginRedirect() {
  if (!state.currentUser) {
    showToast('Please sign in first', 'error');
    setTimeout(() => { window.location.href = 'login.html'; }, 800);
    return false;
  }
  return true;
}

function previewAvatar(input) {
  if (!input.files[0]) return;
  const r = new FileReader();
  r.onload = e => {
    state.avatarDataURL = e.target.result;
    const preview = document.getElementById('regAvatarPreview');
    if (preview) preview.innerHTML = `<img src="${e.target.result}" alt="">`;
  };
  r.readAsDataURL(input.files[0]);
}

// ── Firebase Password Reset (real email!) ─────
async function sendResetCode() {
  const email = document.getElementById('fgEmail').value.trim().toLowerCase();
  const err   = document.getElementById('fgError1');
  err.style.display = 'none';

  if (!email) return showErr(err, 'Please enter your email address.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr(err, 'Invalid email address.');

  try {
    await firebase.auth().sendPasswordResetEmail(email);
    // Show success step
    document.getElementById('fgEmailDisplay').textContent = email;
    document.getElementById('fgStep1').style.display = 'none';
    document.getElementById('fgStep2').style.display = 'block';
  } catch (e) {
    let msg = e.message || 'Could not send reset email.';
    if (msg.includes('user-not-found')) msg = 'No account found with this email address.';
    showErr(err, msg);
  }
}

function setLoggedIn(user) {
  state.currentUser = user;
  updateNavUser();
}
