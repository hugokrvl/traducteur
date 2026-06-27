/* ============================================================================
 * Profils de connexion — clés API CHIFFRÉES (jamais en clair).
 *
 * Chaque profil contient un "blob" chiffré (AES-GCM) qui renferme les clés et
 * réglages de la personne. Il se déverrouille avec le MOT DE PASSE du profil,
 * tapé sur l'écran de connexion. Sans le bon mot de passe → illisible.
 *
 * → Pour (re)générer un blob : ouvre  setup.html  (page outil), entre les clés
 *   + un mot de passe, et colle ici le résultat. Tes clés ne quittent jamais
 *   ton navigateur et n'apparaissent jamais en clair dans le code.
 *
 * Un profil dont le blob vaut null s'affiche comme « à configurer ».
 * ========================================================================== */
window.PROFILES = [
  { name: 'Hugo',     blob: null },
  { name: 'Julia',    blob: null },
  { name: 'Erwan',    blob: null },
  { name: 'Caroline', blob: null },
];
