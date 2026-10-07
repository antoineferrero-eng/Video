import { createBrowserRouter } from 'react-router';
import { NotFound, Shell } from './components/layout/Shell';
import { HomePage } from './features/home/HomePage';

// Les pages secondaires sont chargées à la demande (découpage du bundle).
export const router = createBrowserRouter([
  {
    path: '/lecture',
    lazy: () =>
      import('./features/player/PlayerPage').then((module) => ({ Component: module.PlayerPage })),
  },
  {
    element: <Shell />,
    children: [
      { index: true, element: <HomePage /> },
      {
        path: 'films',
        lazy: () =>
          import('./features/catalog/CatalogPage').then((module) => ({
            Component: () => <module.CatalogPage kind="movie" key="movie" />,
          })),
      },
      {
        path: 'series',
        lazy: () =>
          import('./features/catalog/CatalogPage').then((module) => ({
            Component: () => <module.CatalogPage kind="series" key="series" />,
          })),
      },
      {
        path: 'titre/:id',
        lazy: () =>
          import('./features/title/TitlePage').then((module) => ({ Component: module.TitlePage })),
      },
      {
        path: 'recherche',
        lazy: () =>
          import('./features/search/SearchPage').then((module) => ({
            Component: module.SearchPage,
          })),
      },
      {
        path: 'telechargements',
        lazy: () =>
          import('./features/downloads/DownloadsPage').then((module) => ({
            Component: module.DownloadsPage,
          })),
      },
      {
        path: 'bibliotheque',
        lazy: () =>
          import('./features/library/LibraryPage').then((module) => ({
            Component: module.LibraryPage,
          })),
      },
      {
        path: 'explorateur',
        lazy: () =>
          import('./features/explorer/ExplorerPage').then((module) => ({
            Component: module.ExplorerPage,
          })),
      },
      {
        path: 'parametres',
        lazy: () =>
          import('./features/settings/SettingsPage').then((module) => ({
            Component: module.SettingsPage,
          })),
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
