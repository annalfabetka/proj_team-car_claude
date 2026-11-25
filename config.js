/*
 * Nastavení sdíleného týmu (Firebase / Firestore).
 *
 * Dokud jsou hodnoty prázdné, aplikace běží v režimu „jen toto zařízení“.
 * Postup, jak je získat, je v README.md (část „Sdílený tým“).
 *
 * apiKey se do veřejného repozitáře dává záměrně – u webových aplikací Firebase
 * to není tajemství. Přístup k datům hlídají pravidla databáze (viz README).
 */
window.SPOLUJIZDY_CONFIG = {
  firebase: {
    apiKey: '',
    projectId: '',
  },
  // jak často (ms) se u otevřené stránky načítají změny ostatních
  // pollMs: 15000,
};
