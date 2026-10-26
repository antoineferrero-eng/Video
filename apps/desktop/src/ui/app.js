// Fenêtre de contrôle du prototype : réglages, connexion loadix, essai sur un lien.
const api = window.lumiere;
const $ = (id) => document.getElementById(id);

let lastReport = '';

api.onLog((line) => {
  const log = $('log');
  log.textContent += line + '\n';
  log.scrollTop = log.scrollHeight;
});

function setStatus(id, text, kind) {
  const node = $(id);
  node.textContent = text;
  node.className = `status ${kind ?? ''}`;
}

/** Désactive le bouton pendant l'action et affiche l'erreur éventuelle. */
async function run(button, statusId, action) {
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    if (statusId) setStatus(statusId, cleanError(error), 'error');
  } finally {
    button.disabled = false;
  }
}

function cleanError(error) {
  return String(error?.message ?? error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
}

function showConfig(config) {
  $('loadix-url').value = config.loadixUrl;
  $('loadix-api').value = config.loadixApiUrl;
  $('api-effective').textContent = config.loadixApiEffective;
  setStatus(
    'key-status',
    config.hasOnefichierKey ? 'Une clé est enregistrée.' : 'Aucune clé enregistrée.',
    config.hasOnefichierKey ? 'ok' : '',
  );
}

function showAccount(result) {
  if (result.connected) setStatus('account', `Connecté en tant que ${result.username}.`, 'ok');
  else if (result.connected === false)
    setStatus('account', `Non connecté (${result.detail}).`, 'error');
  else setStatus('account', result.detail);
}

$('save-loadix').addEventListener('click', (event) =>
  run(event.currentTarget, 'account', async () => {
    showConfig(
      await api.saveConfig({
        loadixUrl: $('loadix-url').value,
        loadixApiUrl: $('loadix-api').value,
      }),
    );
  }),
);
$('login').addEventListener('click', (event) =>
  run(event.currentTarget, 'account', async () => {
    setStatus('account', 'Connectez-vous dans la fenêtre loadix…');
    showAccount(await api.login());
  }),
);
$('check').addEventListener('click', (event) =>
  run(event.currentTarget, 'account', async () => showAccount(await api.account())),
);
$('logout').addEventListener('click', (event) =>
  run(event.currentTarget, 'account', async () => showAccount(await api.logout())),
);

$('save-key').addEventListener('click', (event) =>
  run(event.currentTarget, 'key-status', async () => {
    const key = $('onefichier-key').value.trim();
    if (!key) throw new Error('Collez d’abord la clé API.');
    showConfig(await api.saveConfig({ onefichierKey: key }));
    $('onefichier-key').value = '';
  }),
);
$('clear-key').addEventListener('click', (event) =>
  run(event.currentTarget, 'key-status', async () =>
    showConfig(await api.saveConfig({ onefichierKey: '' })),
  ),
);
$('test-key').addEventListener('click', (event) =>
  run(event.currentTarget, 'key-status', async () => {
    const info = await api.testOnefichier();
    setStatus('key-status', `Clé acceptée. ${JSON.stringify(info)}`, 'ok');
  }),
);

$('load-links').addEventListener('click', (event) =>
  run(event.currentTarget, 'media-title', async () => {
    const media = $('media').value.trim();
    const result = await api.links(media);
    setStatus(
      'media-title',
      `${result.title}${result.year ? ` (${result.year})` : ''} — ${result.links.length} version(s) sur ${result.total}.`,
      'ok',
    );
    renderLinks(media, result.links);
  }),
);

function renderLinks(media, links) {
  const body = $('links').querySelector('tbody');
  body.replaceChildren(
    ...links.map((link) => {
      const row = document.createElement('tr');
      const scope =
        link.seasonNumber != null
          ? ` · S${String(link.seasonNumber).padStart(2, '0')}${link.episodeNumber != null ? `E${String(link.episodeNumber).padStart(2, '0')}` : ''}`
          : '';
      for (const [text, className] of [
        [link.quality + scope],
        [link.language],
        [link.sizeHuman],
        [link.provider],
        [link.releaseName ?? '—', 'file'],
      ]) {
        const cell = document.createElement('td');
        cell.textContent = text ?? '';
        if (className) cell.className = className;
        row.append(cell);
      }
      const action = document.createElement('td');
      const button = document.createElement('button');
      button.textContent = 'Télécharger (essai)';
      button.addEventListener('click', () => test(button, media, link));
      action.append(button);
      row.append(action);
      return row;
    }),
  );
  $('links').hidden = links.length === 0;
}

async function test(button, media, link) {
  const summary = {
    provider: link.provider,
    quality: link.quality,
    language: link.language,
    sizeHuman: link.sizeHuman,
    releaseName: link.releaseName,
  };
  for (const other of document.querySelectorAll('#links button')) other.disabled = true;
  try {
    const result = await api.revealAndTest(media, link.id, summary);
    lastReport = result.shareable;
    $('report').textContent = result.shareable;
    $('copy-report').disabled = false;
  } catch (error) {
    $('report').textContent = cleanError(error);
  } finally {
    for (const other of document.querySelectorAll('#links button')) other.disabled = false;
    button.blur();
  }
}

$('copy-report').addEventListener('click', () => api.copy(lastReport));
$('open-reports').addEventListener('click', () => api.openReports());

api.getConfig().then(showConfig);
api
  .account()
  .then(showAccount)
  .catch((error) => setStatus('account', cleanError(error), 'error'));
