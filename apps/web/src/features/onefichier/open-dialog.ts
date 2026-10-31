/** Ouverture de la fenêtre d'ajout d'un lien 1fichier (voir OneFichierInbox). */
const OPEN_EVENT = 'lumiere:1fichier';

/** Recherche lancée sur une source personnalisée : la fenêtre guide jusqu'au Ctrl+V. */
export interface SourceSearch {
  /** Nom de la source (« loadix.fun »). */
  source: string;
  /** Adresse ouverte dans le nouvel onglet (pour la rouvrir). */
  url: string;
  /** Titre cherché : « Dune (2021) », « The Office » (la saison est à part). */
  target: string;
  /** Saison cherchée (série). */
  season: number | null;
}

export interface DialogRequest {
  /** Lien 1fichier reçu (vide : en attente du Ctrl+V). */
  link: string;
  search: SourceSearch | null;
}

/** Demande faite avant que la fenêtre d'ajout soit prête (page du favori au démarrage). */
let listening = false;
let queued: DialogRequest | null = null;

function send(request: DialogRequest): void {
  if (listening)
    window.dispatchEvent(new CustomEvent<DialogRequest>(OPEN_EVENT, { detail: request }));
  else queued = request;
}

/** Ouvre la fenêtre d'ajout d'un lien 1fichier (lien prérempli s'il est connu). */
export function openOneFichierDialog(link = ''): void {
  send({ link, search: null });
}

/** Ouvre la fenêtre qui guide la recherche sur une source, jusqu'au collage du lien. */
export function openSourceSearch(search: SourceSearch): void {
  send({ link: '', search });
}

/** Abonnement de la fenêtre d'ajout aux demandes d'ouverture (y compris celle en attente). */
export function onOneFichierDialogRequest(open: (request: DialogRequest) => void): () => void {
  const listener = (event: Event) => open((event as CustomEvent<DialogRequest>).detail);
  window.addEventListener(OPEN_EVENT, listener);
  listening = true;
  if (queued !== null) {
    open(queued);
    queued = null;
  }
  return () => {
    listening = false;
    window.removeEventListener(OPEN_EVENT, listener);
  };
}
