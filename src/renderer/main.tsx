import React from 'react';
import { createRoot } from 'react-dom/client';
import { migratePrefsOnce } from './state/prefsStorage.ts';
import { App } from './App.tsx';
import './theme.css';

// Before the first render, though nothing depends on it having finished:
// readPref falls back to localStorage, so a person's existing preferences
// are found either way. This just stops that fallback being needed again.
migratePrefsOnce();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
