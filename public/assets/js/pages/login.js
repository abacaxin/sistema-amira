import { login, currentPerfil, sairSilencioso, ehEquipe } from "../auth.js";

const r = await currentPerfil();
if (r && r.user && ehEquipe(r.perfil)) location.replace("/dashboard");
else if (r && r.user) await sairSilencioso();

document.getElementById("root").innerHTML = `
  <div class="login-wrap">
    <form class="login-card" id="f">
      <h1>AMIRA</h1>
      <p>Sistema interno &mdash; acesso restrito</p>
      <label>E-mail</label>
      <input type="email" id="email" required autocomplete="username">
      <label>Senha</label>
      <input type="password" id="senha" required autocomplete="current-password">
      <div id="erro" style="color:var(--err);margin-top:10px;display:none"></div>
      <button class="btn" style="width:100%;margin-top:18px" id="b">Entrar</button>
    </form>
  </div>`;

document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = document.getElementById("b");
  const erro = document.getElementById("erro");
  b.disabled = true;
  erro.style.display = "none";
  try {
    await login(
      document.getElementById("email").value.trim(),
      document.getElementById("senha").value
    );
    const r = await currentPerfil();
    if (!ehEquipe(r?.perfil)) {
      await sairSilencioso();
      erro.textContent = "Esta conta nao tem acesso ao sistema interno.";
      erro.style.display = "block";
      b.disabled = false;
      return;
    }
    location.replace("/dashboard");
  } catch (_) {
    erro.textContent = "E-mail ou senha invalidos.";
    erro.style.display = "block";
    b.disabled = false;
  }
});
