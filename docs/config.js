/* ============================================================================
 * Configuration Supabase — projet DÉDIÉ au Traducteur (distinct de Média).
 *
 * La clé "anon" (publique) est conçue pour être intégrée dans une app web :
 * elle ne donne accès qu'à ce que les règles RLS autorisent (ici : insérer une
 * ligne dans la table `enregistrements`, sans pouvoir la relire). Pas un secret.
 *
 * → Remplis les deux valeurs depuis ton projet Supabase :
 *   Supabase → Project Settings → API → "Project URL" et "anon public".
 * ========================================================================== */
window.SUPABASE_URL = '';        // ex. https://abcdefgh.supabase.co
window.SUPABASE_ANON_KEY = '';   // ex. eyJhbGciOiJIUzI1NiIsInR5cCI6...
