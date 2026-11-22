import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
dotenv.config({ path: ENV_PATH });

// Official GitHub CLI OAuth App Client ID for Device Flow
const GITHUB_CLIENT_ID = '178c6fc778ccc68e1d6a';
const REPO_NAME = 'garmin-studio';

async function startDeviceFlow() {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: 'repo workflow',
    }),
  });

  const data = await res.json();
  if (!data.device_code || !data.user_code) {
    throw new Error(`No se pudo iniciar Device Flow de GitHub: ${JSON.stringify(data)}`);
  }

  console.log('\n========================================================');
  console.log('🔗 VINCULACIÓN RÁPIDA CON GITHUB PAGES (MÓVIL 24/7)');
  console.log('========================================================');
  console.log(`1. Se abrirá en tu navegador: ${data.verification_uri}`);
  console.log(`2. Introduce este código:     ${data.user_code}`);
  console.log('========================================================\n');

  // Open browser automatically
  exec(`start "" "${data.verification_uri}"`);

  const intervalMs = (data.interval || 5) * 1000 + 500;
  const expiresAt = Date.now() + (data.expires_in || 900) * 1000;

  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: data.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      return tokenData.access_token;
    }
    if (tokenData.error === 'authorization_pending') {
      continue;
    }
    if (tokenData.error === 'slow_down') {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    throw new Error(`Error en autorización de GitHub: ${tokenData.error_description || tokenData.error}`);
  }

  throw new Error('Tiempo de espera agotado para autorizar en GitHub.');
}

export async function publishToGitHubPages(token, htmlContent) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Garmin-Fenix7-Studio',
  };

  // 1. Get authenticated user
  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) {
    throw new Error(`Error al obtener usuario de GitHub: ${userRes.status}`);
  }
  const user = await userRes.json();
  const owner = user.login;

  // 2. Ensure repository exists
  const repoCheck = await fetch(`https://api.github.com/repos/${owner}/${REPO_NAME}`, {
    headers,
  });

  if (repoCheck.status === 404) {
    console.log(`Creando repositorio ${owner}/${REPO_NAME} en GitHub...`);
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: REPO_NAME,
        description: 'Garmin Fenix 7 Studio Dashboard (Teide 0-4-0 & Calma)',
        private: false, // GitHub Pages on free accounts requires public repo
        auto_init: true,
      }),
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`No se pudo crear el repositorio: ${errText}`);
    }
    // Wait briefly for initial commit
    await new Promise((r) => setTimeout(r, 2000));
  }

  // 3. Check if index.html already exists to get its SHA
  let existingSha = null;
  const fileCheck = await fetch(
    `https://api.github.com/repos/${owner}/${REPO_NAME}/contents/index.html`,
    { headers }
  );
  if (fileCheck.ok) {
    const fileData = await fileCheck.json();
    existingSha = fileData.sha;
  }

  // 4. Upload / update index.html
  const bodyPayload = {
    message: `Actualización automática Dashboard Garmin (${new Date().toISOString().slice(0, 10)})`,
    content: Buffer.from(htmlContent, 'utf8').toString('base64'),
  };
  if (existingSha) {
    bodyPayload.sha = existingSha;
  }

  const putRes = await fetch(
    `https://api.github.com/repos/${owner}/${REPO_NAME}/contents/index.html`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify(bodyPayload),
    }
  );
  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`Error subiendo index.html a GitHub: ${errText}`);
  }

  // 5. Enable GitHub Pages on default branch if not enabled yet
  const pagesCheck = await fetch(
    `https://api.github.com/repos/${owner}/${REPO_NAME}/pages`,
    { headers }
  );
  if (pagesCheck.status === 404) {
    const repoInfoRes = await fetch(`https://api.github.com/repos/${owner}/${REPO_NAME}`, {
      headers,
    });
    const repoInfo = await repoInfoRes.json();
    const defaultBranch = repoInfo.default_branch || 'main';

    await fetch(`https://api.github.com/repos/${owner}/${REPO_NAME}/pages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: {
          branch: defaultBranch,
          path: '/',
        },
      }),
    });
  }

  const pagesUrl = `https://${owner}.github.io/${REPO_NAME}/`;
  return { owner, repo: REPO_NAME, url: pagesUrl };
}

function saveEnvVar(key, value) {
  let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `${key}=${value}`);
  } else {
    envContent += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, envContent.trim() + '\n', 'utf8');
}

async function main() {
  let token = process.env.GITHUB_TOKEN;
  if (!token) {
    token = await startDeviceFlow();
    saveEnvVar('GITHUB_TOKEN', token);
    console.log('✅ Token de GitHub guardado en .env');
  }

  const dashboardPath = path.join(PROJECT_ROOT, 'dashboard.html');
  const htmlContent = fs.readFileSync(dashboardPath, 'utf8');

  console.log('Publicando tu Dashboard en GitHub Pages...');
  const { url } = await publishToGitHubPages(token, htmlContent);
  saveEnvVar('DASHBOARD_PUBLIC_URL', url);

  console.log('\n========================================================');
  console.log('🎉 ¡DASHBOARD PUBLICADO EN INTERNET PARA TU MÓVIL!');
  console.log(`🌐 Enlace para tu móvil: ${url}`);
  console.log('========================================================\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
}
