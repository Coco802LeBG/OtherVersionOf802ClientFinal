// ============================================================
//  CONFIGURATION DE 802 CLIENT LAUNCHER
//  Modifie ce fichier si ton pseudo GitHub ou tes dépôts changent.
// ============================================================
module.exports = {
  LAUNCHER_NAME: '802 Client',
  MC_VERSION: '1.21.11',

  // Dépôt GitHub du MOD (doit être public, avec des Releases contenant le .jar)
  CLIENT_REPO: 'Coco802/802-client',

  // Dépôt GitHub du LAUNCHER (pour les mises à jour : voir aussi package.json > build > publish)
  LAUNCHER_REPO: 'Coco802/802-launcher',

  // Client ID de ton application Azure (voir README.md, étape 2).
  // Tu peux aussi le coller dans Réglages > Compte Microsoft, sans recompiler.
  AZURE_CLIENT_ID: '',

  // Pseudos autorisés à utiliser le compte de test hors-ligne (mode développeur).
  // Ajoute un pseudo par ligne, exactement comme il apparaît en jeu (sensible à la casse pour l'affichage,
  // mais la vérification ignore la casse). Ça ne vérifie PAS l'achat de Minecraft : ça sert seulement
  // à limiter le compte de test à des gens que tu connais.
  FRIENDS_WHITELIST: [
    'Coco802_',
    'MidnightRaven__'
  ],

  // Identifie le launcher auprès de Modrinth / GitHub / Mojang (obligatoire pour Modrinth)
  USER_AGENT: 'Coco802/802-client-launcher/1.0.0 (github.com/Coco802/802-launcher)'
};
