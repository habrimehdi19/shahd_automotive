Garage Management SaaS — Railway

Environment Variables minimum:
TELEGRAM_BOT_TOKEN=...
DASHBOARD_PASSWORD=...
AUTH_SESSION_SECRET=...
COMPANY_NAME=Nom du garage par défaut
COMPANY_USERNAME=garage
COMPANY_DEFAULT_PASSWORD=...

Super Admin: /admin/login
Garage Login: /login
Employee Portal: /employee

--- TELEGRAM MULTI-GARAGE ---
Le projet utilise maintenant un seul Bot Telegram pour plusieurs garages.
Chaque garage possède automatiquement:
- un lien client unique pour les réservations
- un lien privé de connexion du responsable Telegram
- son propre chatId Telegram pour recevoir uniquement ses notifications

Dans Super Admin > Telegram:
1) Ouvrir "Telegram" pour obtenir le lien de connexion du responsable.
2) Le responsable ouvre le lien dans Telegram puis confirme "Confirmer la liaison".
3) Utiliser "Lien client" pour envoyer au garage son lien de réservation.

Variables Railway nécessaires:
TELEGRAM_BOT_TOKEN = token du bot créé avec BotFather
DASHBOARD_PASSWORD = mot de passe Super Admin

TELEGRAM_BOT_USERNAME est optionnel: le serveur récupère automatiquement le username du bot avec getMe().

IMPORTANT: ne pas utiliser OWNER_CHAT_ID ou BOT_COMPANY_ID pour le mode multi-garage.


FIX: employee dashboard JavaScript syntax corrected; employee login is scoped by garage link; employee username is immutable after creation.
