/* ------------------------------------------------------------- languages */

/*
 * The panel in other languages. Pages are written in English; this layer
 * swaps the interface's own words (navigation, buttons, headings, statuses,
 * field labels) as they appear, including on pages drawn later. Server
 * consoles, file contents, names and anything people typed are never touched.
 *
 * Strings that are not in the dictionary stay in English, so a page is never
 * broken by a missing translation; add more below as [nl, de, es, fr, pt-BR].
 */

export const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'nl', label: 'Nederlands' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'pt', label: 'Português (Brasil)' },
];

const ORDER = ['nl', 'de', 'es', 'fr', 'pt'];

// English → [Dutch, German, Spanish, French, Portuguese (Brazil)]
const DICT = {
  // Navigation and top bar
  Dashboard: ['Dashboard', 'Dashboard', 'Panel', 'Tableau de bord', 'Painel'],
  Servers: ['Servers', 'Server', 'Servidores', 'Serveurs', 'Servidores'],
  Games: ['Games', 'Spiele', 'Juegos', 'Jeux', 'Jogos'],
  Activity: ['Activiteit', 'Aktivität', 'Actividad', 'Activité', 'Atividade'],
  'Audit log': ['Auditlogboek', 'Audit-Log', 'Registro de auditoría', "Journal d'audit", 'Log de auditoria'],
  Nodes: ['Nodes', 'Knoten', 'Nodos', 'Nœuds', 'Nós'],
  Users: ['Gebruikers', 'Benutzer', 'Usuarios', 'Utilisateurs', 'Usuários'],
  Connections: ['Verbindingen', 'Verbindungen', 'Conexiones', 'Connexions', 'Conexões'],
  Settings: ['Instellingen', 'Einstellungen', 'Ajustes', 'Paramètres', 'Configurações'],
  Account: ['Account', 'Konto', 'Cuenta', 'Compte', 'Conta'],
  'New server': ['Nieuwe server', 'Neuer Server', 'Nuevo servidor', 'Nouveau serveur', 'Novo servidor'],
  Notifications: ['Meldingen', 'Benachrichtigungen', 'Notificaciones', 'Notifications', 'Notificações'],
  'Pop-ups': ['Pop-ups', 'Pop-ups', 'Ventanas', 'Pop-ups', 'Pop-ups'],
  'Desktop alerts': ['Bureaubladmeldingen', 'Desktop-Hinweise', 'Avisos de escritorio', 'Alertes de bureau', 'Alertas na área de trabalho'],
  'Sign out': ['Afmelden', 'Abmelden', 'Cerrar sesión', 'Se déconnecter', 'Sair'],
  'No servers yet': ['Nog geen servers', 'Noch keine Server', 'Aún no hay servidores', 'Pas encore de serveur', 'Nenhum servidor ainda'],

  // Sign-in
  'Welcome back': ['Welkom terug', 'Willkommen zurück', 'Bienvenido de nuevo', 'Bon retour', 'Bem-vindo de volta'],
  'Sign in to manage your game servers': ['Meld je aan om je gameservers te beheren', 'Melde dich an, um deine Gameserver zu verwalten', 'Inicia sesión para gestionar tus servidores', 'Connectez-vous pour gérer vos serveurs de jeu', 'Entre para gerenciar seus servidores de jogos'],
  Username: ['Gebruikersnaam', 'Benutzername', 'Usuario', "Nom d'utilisateur", 'Usuário'],
  Password: ['Wachtwoord', 'Passwort', 'Contraseña', 'Mot de passe', 'Senha'],
  'Confirm password': ['Bevestig wachtwoord', 'Passwort bestätigen', 'Confirmar contraseña', 'Confirmer le mot de passe', 'Confirmar senha'],
  'Sign in': ['Aanmelden', 'Anmelden', 'Iniciar sesión', 'Se connecter', 'Entrar'],
  'Set up your panel': ['Stel je panel in', 'Richte dein Panel ein', 'Configura tu panel', 'Configurez votre panneau', 'Configure seu painel'],
  'Create the first administrator account': ['Maak het eerste beheerdersaccount', 'Erstelle das erste Administratorkonto', 'Crea la primera cuenta de administrador', 'Créez le premier compte administrateur', 'Crie a primeira conta de administrador'],
  'Create account': ['Account maken', 'Konto erstellen', 'Crear cuenta', 'Créer le compte', 'Criar conta'],
  'Two-step verification': ['Verificatie in twee stappen', 'Zwei-Schritt-Verifizierung', 'Verificación en dos pasos', 'Vérification en deux étapes', 'Verificação em duas etapas'],
  Authenticator: ['Authenticator', 'Authenticator', 'Autenticador', 'Authentificateur', 'Autenticador'],
  'Recovery code': ['Herstelcode', 'Wiederherstellungscode', 'Código de recuperación', 'Code de récupération', 'Código de recuperação'],
  'Use a different account': ['Ander account gebruiken', 'Anderes Konto verwenden', 'Usar otra cuenta', 'Utiliser un autre compte', 'Usar outra conta'],
  or: ['of', 'oder', 'o', 'ou', 'ou'],
  'Sign in with Google': ['Aanmelden met Google', 'Mit Google anmelden', 'Iniciar sesión con Google', 'Se connecter avec Google', 'Entrar com Google'],
  'Sign in with Discord': ['Aanmelden met Discord', 'Mit Discord anmelden', 'Iniciar sesión con Discord', 'Se connecter avec Discord', 'Entrar com Discord'],
  'Sign in with GitHub': ['Aanmelden met GitHub', 'Mit GitHub anmelden', 'Iniciar sesión con GitHub', 'Se connecter avec GitHub', 'Entrar com GitHub'],

  // Server statuses
  Offline: ['Offline', 'Offline', 'Desconectado', 'Hors ligne', 'Offline'],
  Online: ['Online', 'Online', 'En línea', 'En ligne', 'Online'],
  Installing: ['Installeren', 'Installiert', 'Instalando', 'Installation', 'Instalando'],
  'Install failed': ['Installatie mislukt', 'Installation fehlgeschlagen', 'Falló la instalación', "Échec de l'installation", 'Falha na instalação'],
  Starting: ['Opstarten', 'Startet', 'Iniciando', 'Démarrage', 'Iniciando'],
  Running: ['Actief', 'Läuft', 'En marcha', 'En cours', 'Em execução'],
  Stopping: ['Stoppen', 'Stoppt', 'Deteniendo', 'Arrêt', 'Parando'],
  Crashed: ['Gecrasht', 'Abgestürzt', 'Caído', 'Planté', 'Travou'],
  Maintenance: ['Onderhoud', 'Wartung', 'Mantenimiento', 'Maintenance', 'Manutenção'],

  // Power and common buttons
  Start: ['Starten', 'Starten', 'Iniciar', 'Démarrer', 'Iniciar'],
  Stop: ['Stoppen', 'Stoppen', 'Detener', 'Arrêter', 'Parar'],
  Restart: ['Herstarten', 'Neu starten', 'Reiniciar', 'Redémarrer', 'Reiniciar'],
  'Force kill': ['Geforceerd stoppen', 'Zwangsweise beenden', 'Forzar cierre', 'Forcer l’arrêt', 'Forçar encerramento'],
  'Start all': ['Alles starten', 'Alle starten', 'Iniciar todos', 'Tout démarrer', 'Iniciar todos'],
  'Stop all': ['Alles stoppen', 'Alle stoppen', 'Detener todos', 'Tout arrêter', 'Parar todos'],
  'Message all': ['Bericht aan allen', 'Nachricht an alle', 'Mensaje a todos', 'Message à tous', 'Mensagem para todos'],
  'Import existing': ['Bestaande importeren', 'Vorhandenen importieren', 'Importar existente', "Importer l'existant", 'Importar existente'],
  Cancel: ['Annuleren', 'Abbrechen', 'Cancelar', 'Annuler', 'Cancelar'],
  Save: ['Opslaan', 'Speichern', 'Guardar', 'Enregistrer', 'Salvar'],
  'Save changes': ['Wijzigingen opslaan', 'Änderungen speichern', 'Guardar cambios', 'Enregistrer les modifications', 'Salvar alterações'],
  Close: ['Sluiten', 'Schließen', 'Cerrar', 'Fermer', 'Fechar'],
  Delete: ['Verwijderen', 'Löschen', 'Eliminar', 'Supprimer', 'Excluir'],
  Edit: ['Bewerken', 'Bearbeiten', 'Editar', 'Modifier', 'Editar'],
  Remove: ['Verwijderen', 'Entfernen', 'Quitar', 'Retirer', 'Remover'],
  Add: ['Toevoegen', 'Hinzufügen', 'Añadir', 'Ajouter', 'Adicionar'],
  Search: ['Zoeken', 'Suchen', 'Buscar', 'Rechercher', 'Pesquisar'],
  Copy: ['Kopiëren', 'Kopieren', 'Copiar', 'Copier', 'Copiar'],
  'Copy link': ['Link kopiëren', 'Link kopieren', 'Copiar enlace', 'Copier le lien', 'Copiar link'],
  Open: ['Openen', 'Öffnen', 'Abrir', 'Ouvrir', 'Abrir'],
  Download: ['Downloaden', 'Herunterladen', 'Descargar', 'Télécharger', 'Baixar'],
  Upload: ['Uploaden', 'Hochladen', 'Subir', 'Téléverser', 'Enviar'],
  Install: ['Installeren', 'Installieren', 'Instalar', 'Installer', 'Instalar'],
  Deploy: ['Uitrollen', 'Bereitstellen', 'Desplegar', 'Déployer', 'Implantar'],
  Next: ['Volgende', 'Weiter', 'Siguiente', 'Suivant', 'Próximo'],
  Back: ['Terug', 'Zurück', 'Atrás', 'Retour', 'Voltar'],
  Done: ['Klaar', 'Fertig', 'Listo', 'Terminé', 'Concluído'],
  Confirm: ['Bevestigen', 'Bestätigen', 'Confirmar', 'Confirmer', 'Confirmar'],
  Rename: ['Hernoemen', 'Umbenennen', 'Renombrar', 'Renommer', 'Renomear'],
  Duplicate: ['Dupliceren', 'Duplizieren', 'Duplicar', 'Dupliquer', 'Duplicar'],
  Export: ['Exporteren', 'Exportieren', 'Exportar', 'Exporter', 'Exportar'],
  Import: ['Importeren', 'Importieren', 'Importar', 'Importer', 'Importar'],
  Reinstall: ['Opnieuw installeren', 'Neu installieren', 'Reinstalar', 'Réinstaller', 'Reinstalar'],
  'Delete server': ['Server verwijderen', 'Server löschen', 'Eliminar servidor', 'Supprimer le serveur', 'Excluir servidor'],
  'Turn on': ['Aanzetten', 'Einschalten', 'Activar', 'Activer', 'Ativar'],
  'Turn off': ['Uitzetten', 'Ausschalten', 'Desactivar', 'Désactiver', 'Desativar'],
  'View all': ['Alles bekijken', 'Alle anzeigen', 'Ver todo', 'Tout voir', 'Ver tudo'],
  Hide: ['Verbergen', 'Ausblenden', 'Ocultar', 'Masquer', 'Ocultar'],
  History: ['Geschiedenis', 'Verlauf', 'Historial', 'Historique', 'Histórico'],
  'New folder': ['Nieuwe map', 'Neuer Ordner', 'Nueva carpeta', 'Nouveau dossier', 'Nova pasta'],
  'New file': ['Nieuw bestand', 'Neue Datei', 'Nuevo archivo', 'Nouveau fichier', 'Novo arquivo'],
  Unpack: ['Uitpakken', 'Entpacken', 'Descomprimir', 'Décompresser', 'Descompactar'],
  Compress: ['Comprimeren', 'Komprimieren', 'Comprimir', 'Compresser', 'Compactar'],
  'Create backup': ['Back-up maken', 'Backup erstellen', 'Crear copia de seguridad', 'Créer une sauvegarde', 'Criar backup'],
  'Add task': ['Taak toevoegen', 'Aufgabe hinzufügen', 'Añadir tarea', 'Ajouter une tâche', 'Adicionar tarefa'],
  'Add event': ['Evenement toevoegen', 'Ereignis hinzufügen', 'Añadir evento', 'Ajouter un événement', 'Adicionar evento'],
  'Start now': ['Nu starten', 'Jetzt starten', 'Iniciar ahora', 'Démarrer maintenant', 'Iniciar agora'],
  'End now': ['Nu beëindigen', 'Jetzt beenden', 'Terminar ahora', 'Terminer maintenant', 'Encerrar agora'],
  'Change version': ['Versie wijzigen', 'Version ändern', 'Cambiar versión', 'Changer de version', 'Mudar versão'],
  'Old logs': ['Oude logs', 'Alte Logs', 'Registros antiguos', 'Anciens journaux', 'Logs antigos'],
  'Share log': ['Log delen', 'Log teilen', 'Compartir registro', 'Partager le journal', 'Compartilhar log'],
  Send: ['Versturen', 'Senden', 'Enviar', 'Envoyer', 'Enviar'],
  'Send test': ['Test versturen', 'Test senden', 'Enviar prueba', 'Envoyer un test', 'Enviar teste'],
  'Take the tour': ['Rondleiding volgen', 'Tour starten', 'Hacer el recorrido', 'Faire la visite', 'Fazer o tour'],
  'Skip tour': ['Rondleiding overslaan', 'Tour überspringen', 'Saltar recorrido', 'Passer la visite', 'Pular tour'],
  'Test from the internet': ['Testen vanaf internet', 'Aus dem Internet testen', 'Probar desde internet', 'Tester depuis internet', 'Testar pela internet'],
  'Open these ports': ['Deze poorten openen', 'Diese Ports öffnen', 'Abrir estos puertos', 'Ouvrir ces ports', 'Abrir estas portas'],
  'Do it manually': ['Handmatig doen', 'Manuell erledigen', 'Hacerlo a mano', 'Le faire à la main', 'Fazer manualmente'],
  'Select all': ['Alles selecteren', 'Alle auswählen', 'Seleccionar todo', 'Tout sélectionner', 'Selecionar tudo'],
  Clear: ['Wissen', 'Leeren', 'Limpiar', 'Effacer', 'Limpar'],

  // Server tabs
  Console: ['Console', 'Konsole', 'Consola', 'Console', 'Console'],
  Players: ['Spelers', 'Spieler', 'Jugadores', 'Joueurs', 'Jogadores'],
  Metrics: ['Statistieken', 'Metriken', 'Métricas', 'Métriques', 'Métricas'],
  Files: ['Bestanden', 'Dateien', 'Archivos', 'Fichiers', 'Arquivos'],
  Mods: ['Mods', 'Mods', 'Mods', 'Mods', 'Mods'],
  Modpacks: ['Modpacks', 'Modpacks', 'Modpacks', 'Modpacks', 'Modpacks'],
  Backups: ['Back-ups', 'Backups', 'Copias de seguridad', 'Sauvegardes', 'Backups'],
  Schedules: ['Planning', 'Zeitpläne', 'Programación', 'Planification', 'Agendamentos'],
  'Game settings': ['Spelinstellingen', 'Spieleinstellungen', 'Ajustes del juego', 'Paramètres du jeu', 'Configurações do jogo'],
  Access: ['Toegang', 'Zugriff', 'Acceso', 'Accès', 'Acesso'],

  // Page headings and cards
  Overview: ['Overzicht', 'Übersicht', 'Resumen', 'Vue d’ensemble', 'Visão geral'],
  'Get your panel ready': ['Maak je panel klaar', 'Mach dein Panel bereit', 'Prepara tu panel', 'Préparez votre panneau', 'Prepare seu painel'],
  'Ready-made setups': ['Kant-en-klare opzetten', 'Fertige Setups', 'Configuraciones listas', 'Configurations prêtes', 'Configurações prontas'],
  'Your quota': ['Je quotum', 'Dein Kontingent', 'Tu cuota', 'Votre quota', 'Sua cota'],
  'Scheduled tasks': ['Geplande taken', 'Geplante Aufgaben', 'Tareas programadas', 'Tâches planifiées', 'Tarefas agendadas'],
  'Scheduled events': ['Geplande evenementen', 'Geplante Ereignisse', 'Eventos programados', 'Événements planifiés', 'Eventos agendados'],
  'Chat announcements': ['Chatmededelingen', 'Chat-Ankündigungen', 'Anuncios en el chat', 'Annonces dans le chat', 'Anúncios no chat'],
  'Danger zone': ['Gevarenzone', 'Gefahrenbereich', 'Zona de peligro', 'Zone dangereuse', 'Zona de perigo'],
  Reachability: ['Bereikbaarheid', 'Erreichbarkeit', 'Accesibilidad', 'Accessibilité', 'Alcance'],
  Ports: ['Poorten', 'Ports', 'Puertos', 'Ports', 'Portas'],
  'Template variables': ['Sjabloonvariabelen', 'Vorlagenvariablen', 'Variables de plantilla', 'Variables du modèle', 'Variáveis do modelo'],
  Alerts: ['Waarschuwingen', 'Warnungen', 'Alertas', 'Alertes', 'Alertas'],
  General: ['Algemeen', 'Allgemein', 'General', 'Général', 'Geral'],
  'World map': ['Wereldkaart', 'Weltkarte', 'Mapa del mundo', 'Carte du monde', 'Mapa do mundo'],
  'Live map': ['Live-kaart', 'Live-Karte', 'Mapa en vivo', 'Carte en direct', 'Mapa ao vivo'],
  'Workshop packs': ['Workshop-pakketten', 'Workshop-Pakete', 'Paquetes del Workshop', 'Packs du Workshop', 'Pacotes da Workshop'],
  'Config history': ['Configuratiegeschiedenis', 'Konfigurationsverlauf', 'Historial de configuración', 'Historique de configuration', 'Histórico de configuração'],
  'Two-factor sign-in': ['Aanmelden in twee stappen', 'Zwei-Faktor-Anmeldung', 'Inicio de sesión en dos pasos', 'Connexion à deux facteurs', 'Login em duas etapas'],
  'iPhone app': ['iPhone-app', 'iPhone-App', 'App para iPhone', 'App iPhone', 'App para iPhone'],
  'Change your password': ['Wachtwoord wijzigen', 'Passwort ändern', 'Cambiar la contraseña', 'Changer de mot de passe', 'Alterar sua senha'],
  'Current password': ['Huidig wachtwoord', 'Aktuelles Passwort', 'Contraseña actual', 'Mot de passe actuel', 'Senha atual'],
  'New password': ['Nieuw wachtwoord', 'Neues Passwort', 'Nueva contraseña', 'Nouveau mot de passe', 'Nova senha'],
  'Update password': ['Wachtwoord bijwerken', 'Passwort aktualisieren', 'Actualizar contraseña', 'Mettre à jour le mot de passe', 'Atualizar senha'],
  'Other devices': ['Andere apparaten', 'Andere Geräte', 'Otros dispositivos', 'Autres appareils', 'Outros dispositivos'],
  'Sign out other devices': ['Andere apparaten afmelden', 'Andere Geräte abmelden', 'Cerrar sesión en otros dispositivos', 'Déconnecter les autres appareils', 'Sair dos outros dispositivos'],
  'API keys': ['API-sleutels', 'API-Schlüssel', 'Claves de API', 'Clés API', 'Chaves de API'],
  'This browser': ['Deze browser', 'Dieser Browser', 'Este navegador', 'Ce navigateur', 'Este navegador'],
  Language: ['Taal', 'Sprache', 'Idioma', 'Langue', 'Idioma'],
  'Sign in with another account': ['Aanmelden met een ander account', 'Mit einem anderen Konto anmelden', 'Iniciar sesión con otra cuenta', 'Se connecter avec un autre compte', 'Entrar com outra conta'],
  'Public server list': ['Openbare serverlijst', 'Öffentliche Serverliste', 'Lista pública de servidores', 'Liste publique des serveurs', 'Lista pública de servidores'],
  'Panel updates': ['Panelupdates', 'Panel-Updates', 'Actualizaciones del panel', 'Mises à jour du panneau', 'Atualizações do painel'],
  'Check for updates': ['Zoeken naar updates', 'Nach Updates suchen', 'Buscar actualizaciones', 'Rechercher des mises à jour', 'Verificar atualizações'],
  Runtime: ['Runtime', 'Laufzeit', 'Entorno', 'Environnement', 'Ambiente'],
  Limits: ['Limieten', 'Grenzen', 'Límites', 'Limites', 'Limites'],
  Integrations: ['Integraties', 'Integrationen', 'Integraciones', 'Intégrations', 'Integrações'],
  'Cloud backups': ['Cloudback-ups', 'Cloud-Backups', 'Copias en la nube', 'Sauvegardes cloud', 'Backups na nuvem'],
  'Discord bot': ['Discord-bot', 'Discord-Bot', 'Bot de Discord', 'Bot Discord', 'Bot do Discord'],
  System: ['Systeem', 'System', 'Sistema', 'Système', 'Sistema'],
  'Save settings': ['Instellingen opslaan', 'Einstellungen speichern', 'Guardar ajustes', 'Enregistrer les paramètres', 'Salvar configurações'],
  'Save alerts': ['Waarschuwingen opslaan', 'Warnungen speichern', 'Guardar alertas', 'Enregistrer les alertes', 'Salvar alertas'],
  'Save limits': ['Limieten opslaan', 'Grenzen speichern', 'Guardar límites', 'Enregistrer les limites', 'Salvar limites'],
  'Save integrations': ['Integraties opslaan', 'Integrationen speichern', 'Guardar integraciones', 'Enregistrer les intégrations', 'Salvar integrações'],
  'Save server list': ['Serverlijst opslaan', 'Serverliste speichern', 'Guardar lista de servidores', 'Enregistrer la liste', 'Salvar lista de servidores'],
  'Require two-factor for administrators': ['Twee stappen verplicht voor beheerders', 'Zwei-Faktor für Administratoren verlangen', 'Exigir dos pasos a los administradores', 'Exiger la double authentification pour les admins', 'Exigir duas etapas para administradores'],
  'New user': ['Nieuwe gebruiker', 'Neuer Benutzer', 'Nuevo usuario', 'Nouvel utilisateur', 'Novo usuário'],
  'Add node': ['Node toevoegen', 'Knoten hinzufügen', 'Añadir nodo', 'Ajouter un nœud', 'Adicionar nó'],
  'This machine': ['Deze machine', 'Dieser Rechner', 'Esta máquina', 'Cette machine', 'Esta máquina'],

  // Table headings and labels
  Name: ['Naam', 'Name', 'Nombre', 'Nom', 'Nome'],
  'Server name': ['Servernaam', 'Servername', 'Nombre del servidor', 'Nom du serveur', 'Nome do servidor'],
  Server: ['Server', 'Server', 'Servidor', 'Serveur', 'Servidor'],
  Status: ['Status', 'Status', 'Estado', 'Statut', 'Status'],
  Memory: ['Geheugen', 'Arbeitsspeicher', 'Memoria', 'Mémoire', 'Memória'],
  Disk: ['Schijf', 'Speicherplatz', 'Disco', 'Disque', 'Disco'],
  Network: ['Netwerk', 'Netzwerk', 'Red', 'Réseau', 'Rede'],
  Size: ['Grootte', 'Größe', 'Tamaño', 'Taille', 'Tamanho'],
  Modified: ['Gewijzigd', 'Geändert', 'Modificado', 'Modifié', 'Modificado'],
  Created: ['Gemaakt', 'Erstellt', 'Creado', 'Créé', 'Criado'],
  Version: ['Versie', 'Version', 'Versión', 'Version', 'Versão'],
  Role: ['Rol', 'Rolle', 'Rol', 'Rôle', 'Função'],
  Permissions: ['Rechten', 'Berechtigungen', 'Permisos', 'Permissions', 'Permissões'],
  'Last login': ['Laatst aangemeld', 'Letzte Anmeldung', 'Último acceso', 'Dernière connexion', 'Último acesso'],
  'Last seen': ['Laatst gezien', 'Zuletzt gesehen', 'Visto por última vez', 'Vu pour la dernière fois', 'Visto por último'],
  'Play time': ['Speeltijd', 'Spielzeit', 'Tiempo de juego', 'Temps de jeu', 'Tempo de jogo'],
  Player: ['Speler', 'Spieler', 'Jugador', 'Joueur', 'Jogador'],
  'Players online': ['Spelers online', 'Spieler online', 'Jugadores conectados', 'Joueurs en ligne', 'Jogadores online'],
  'Servers online': ['Servers online', 'Server online', 'Servidores en línea', 'Serveurs en ligne', 'Servidores online'],
  Crashes: ['Crashes', 'Abstürze', 'Caídas', 'Plantages', 'Travamentos'],
  Event: ['Gebeurtenis', 'Ereignis', 'Evento', 'Événement', 'Evento'],
  When: ['Wanneer', 'Wann', 'Cuándo', 'Quand', 'Quando'],
  Who: ['Wie', 'Wer', 'Quién', 'Qui', 'Quem'],
  Did: ['Deed', 'Aktion', 'Acción', 'Action', 'Ação'],
  From: ['Vanaf', 'Von', 'Desde', 'Depuis', 'De'],
  Port: ['Poort', 'Port', 'Puerto', 'Port', 'Porta'],
  Protocol: ['Protocol', 'Protokoll', 'Protocolo', 'Protocole', 'Protocolo'],
  Firewall: ['Firewall', 'Firewall', 'Cortafuegos', 'Pare-feu', 'Firewall'],
  'From the internet': ['Vanaf internet', 'Aus dem Internet', 'Desde internet', 'Depuis internet', 'Pela internet'],
  Backup: ['Back-up', 'Backup', 'Copia', 'Sauvegarde', 'Backup'],
  Title: ['Titel', 'Titel', 'Título', 'Titre', 'Título'],
  Description: ['Beschrijving', 'Beschreibung', 'Descripción', 'Description', 'Descrição'],
  Website: ['Website', 'Webseite', 'Sitio web', 'Site web', 'Site'],
  'Discord invite': ['Discord-uitnodiging', 'Discord-Einladung', 'Invitación de Discord', 'Invitation Discord', 'Convite do Discord'],
  'Vote link': ['Stemlink', 'Abstimmungslink', 'Enlace de votación', 'Lien de vote', 'Link de votação'],
  'Memory limit (MB)': ['Geheugenlimiet (MB)', 'Speicherlimit (MB)', 'Límite de memoria (MB)', 'Limite de mémoire (Mo)', 'Limite de memória (MB)'],
  'Max players': ['Max. spelers', 'Max. Spieler', 'Máx. jugadores', 'Joueurs max.', 'Máx. jogadores'],
  'Start command': ['Startopdracht', 'Startbefehl', 'Comando de inicio', 'Commande de démarrage', 'Comando de início'],
  'Start automatically when the panel boots': ['Automatisch starten met het panel', 'Beim Start des Panels automatisch starten', 'Iniciar automáticamente con el panel', 'Démarrer automatiquement avec le panneau', 'Iniciar automaticamente com o painel'],
  'Restart automatically after a crash': ['Automatisch herstarten na een crash', 'Nach einem Absturz automatisch neu starten', 'Reiniciar automáticamente tras una caída', 'Redémarrer automatiquement après un plantage', 'Reiniciar automaticamente após travar'],
  'Stop when empty for (minutes)': ['Stoppen als het leeg is (minuten)', 'Stoppen, wenn leer seit (Minuten)', 'Detener si está vacío durante (minutos)', 'Arrêter si vide depuis (minutes)', 'Parar quando vazio por (minutos)'],
  'Restart when frozen for (minutes)': ['Herstarten als het vastloopt (minuten)', 'Neu starten, wenn eingefroren seit (Minuten)', 'Reiniciar si se congela durante (minutos)', 'Redémarrer si bloqué depuis (minutes)', 'Reiniciar quando travado por (minutos)'],
  'Pick a game': ['Kies een game', 'Wähle ein Spiel', 'Elige un juego', 'Choisissez un jeu', 'Escolha um jogo'],
  'Search games…': ['Games zoeken…', 'Spiele suchen…', 'Buscar juegos…', 'Rechercher des jeux…', 'Pesquisar jogos…'],
  'Loading…': ['Laden…', 'Wird geladen…', 'Cargando…', 'Chargement…', 'Carregando…'],
  'Searching…': ['Zoeken…', 'Suche…', 'Buscando…', 'Recherche…', 'Pesquisando…'],
  'Loading files…': ['Bestanden laden…', 'Dateien werden geladen…', 'Cargando archivos…', 'Chargement des fichiers…', 'Carregando arquivos…'],
  'Loading backups…': ['Back-ups laden…', 'Backups werden geladen…', 'Cargando copias…', 'Chargement des sauvegardes…', 'Carregando backups…'],
  'Loading schedules…': ['Planning laden…', 'Zeitpläne werden geladen…', 'Cargando programación…', 'Chargement de la planification…', 'Carregando agendamentos…'],
  'No backups yet': ['Nog geen back-ups', 'Noch keine Backups', 'Aún no hay copias', 'Pas encore de sauvegarde', 'Nenhum backup ainda'],
  'Not tested': ['Niet getest', 'Nicht getestet', 'Sin probar', 'Non testé', 'Não testado'],
  'not tested': ['niet getest', 'nicht getestet', 'sin probar', 'non testé', 'não testado'],
  reachable: ['bereikbaar', 'erreichbar', 'accesible', 'accessible', 'acessível'],
  'not reachable': ['niet bereikbaar', 'nicht erreichbar', 'no accesible', 'non accessible', 'não acessível'],
  open: ['open', 'offen', 'abierto', 'ouvert', 'aberto'],
  closed: ['dicht', 'geschlossen', 'cerrado', 'fermé', 'fechado'],
  Everyone: ['Iedereen', 'Alle', 'Todos', 'Tout le monde', 'Todos'],
  'Any server': ['Elke server', 'Jeder Server', 'Cualquier servidor', "N'importe quel serveur", 'Qualquer servidor'],
  Older: ['Ouder', 'Älter', 'Anteriores', 'Plus ancien', 'Mais antigos'],
  'Nothing yet. Crashes, installs, backups and sign-ins show up here.': ['Nog niets. Crashes, installaties, back-ups en aanmeldingen verschijnen hier.', 'Noch nichts. Abstürze, Installationen, Backups und Anmeldungen erscheinen hier.', 'Nada aún. Aquí aparecen caídas, instalaciones, copias e inicios de sesión.', 'Rien pour le moment. Plantages, installations, sauvegardes et connexions apparaissent ici.', 'Nada ainda. Travamentos, instalações, backups e logins aparecem aqui.'],

  // Dashboard checklist and server settings hints
  'Create your first server': ['Maak je eerste server', 'Erstelle deinen ersten Server', 'Crea tu primer servidor', 'Créez votre premier serveur', 'Crie seu primeiro servidor'],
  'Start a server and see it come online': ['Start een server en zie hem online komen', 'Starte einen Server und sieh, wie er online geht', 'Inicia un servidor y míralo conectarse', 'Démarrez un serveur et regardez-le passer en ligne', 'Inicie um servidor e veja-o ficar online'],
  'Open its ports so friends can join': ['Open de poorten zodat vrienden kunnen meedoen', 'Öffne die Ports, damit Freunde beitreten können', 'Abre sus puertos para que tus amigos entren', 'Ouvrez ses ports pour que vos amis rejoignent', 'Abra as portas para os amigos entrarem'],
  'Schedule a backup': ['Plan een back-up', 'Plane ein Backup', 'Programa una copia de seguridad', 'Planifiez une sauvegarde', 'Agende um backup'],
  'Get crash alerts on Discord': ['Ontvang crashmeldingen op Discord', 'Erhalte Absturzwarnungen auf Discord', 'Recibe avisos de caídas en Discord', 'Recevez les alertes de plantage sur Discord', 'Receba alertas de travamento no Discord'],
  'Collecting data…': ['Gegevens verzamelen…', 'Daten werden gesammelt…', 'Recogiendo datos…', 'Collecte des données…', 'Coletando dados…'],
  'Saves RAM and CPU on a server nobody is using. 0 keeps it running.': ['Bespaart RAM en CPU als niemand de server gebruikt. 0 laat hem draaien.', 'Spart RAM und CPU, wenn niemand den Server nutzt. 0 lässt ihn laufen.', 'Ahorra RAM y CPU si nadie usa el servidor. 0 lo mantiene encendido.', 'Économise RAM et CPU quand personne ne joue. 0 le laisse tourner.', 'Economiza RAM e CPU quando ninguém está usando. 0 o mantém ligado.'],
  'Restarts the server if it stops answering players while still running. 0 turns this off.': ['Herstart de server als hij niet meer reageert terwijl hij draait. 0 zet dit uit.', 'Startet den Server neu, wenn er nicht mehr antwortet, aber noch läuft. 0 schaltet das aus.', 'Reinicia el servidor si deja de responder sin haberse caído. 0 lo desactiva.', 'Redémarre le serveur s’il ne répond plus tout en tournant. 0 désactive.', 'Reinicia o servidor se ele parar de responder enquanto roda. 0 desativa.'],
  "Empty uses the game's own start command": ['Leeg gebruikt de eigen startopdracht van de game', 'Leer verwendet den Startbefehl des Spiels', 'Vacío usa el comando propio del juego', 'Vide utilise la commande du jeu', 'Vazio usa o comando do próprio jogo'],
  'Only administrators can change the start command.': ['Alleen beheerders kunnen de startopdracht wijzigen.', 'Nur Administratoren können den Startbefehl ändern.', 'Solo los administradores pueden cambiar el comando de inicio.', 'Seuls les administrateurs peuvent changer la commande de démarrage.', 'Só administradores podem alterar o comando de início.'],
  'Nothing scheduled. A nightly restart and a backup every 6 hours keep most servers healthy.': ['Niets gepland. Een herstart elke nacht en een back-up elke 6 uur houden de meeste servers gezond.', 'Nichts geplant. Ein nächtlicher Neustart und alle 6 Stunden ein Backup halten die meisten Server gesund.', 'Nada programado. Un reinicio nocturno y una copia cada 6 horas mantienen sanos a la mayoría de servidores.', 'Rien de planifié. Un redémarrage nocturne et une sauvegarde toutes les 6 heures suffisent à la plupart des serveurs.', 'Nada agendado. Um reinício à noite e um backup a cada 6 horas mantêm a maioria dos servidores saudável.'],
  'Restart daily at 05:00': ['Dagelijks herstarten om 05:00', 'Täglich um 05:00 neu starten', 'Reiniciar a diario a las 05:00', 'Redémarrer chaque jour à 05:00', 'Reiniciar diariamente às 05:00'],
  'Back up every 6 hours': ['Elke 6 uur een back-up', 'Alle 6 Stunden sichern', 'Copia cada 6 horas', 'Sauvegarder toutes les 6 heures', 'Backup a cada 6 horas'],
  'Times use the clock of the machine running the panel.': ['Tijden volgen de klok van de machine waarop het panel draait.', 'Zeiten richten sich nach der Uhr des Rechners mit dem Panel.', 'Las horas siguen el reloj de la máquina del panel.', 'Les heures suivent l’horloge de la machine du panneau.', 'Os horários seguem o relógio da máquina do painel.'],

  // Toasts
  Saved: ['Opgeslagen', 'Gespeichert', 'Guardado', 'Enregistré', 'Salvo'],
  'Settings saved': ['Instellingen opgeslagen', 'Einstellungen gespeichert', 'Ajustes guardados', 'Paramètres enregistrés', 'Configurações salvas'],
  'Server deleted': ['Server verwijderd', 'Server gelöscht', 'Servidor eliminado', 'Serveur supprimé', 'Servidor excluído'],
  'Password updated': ['Wachtwoord bijgewerkt', 'Passwort aktualisiert', 'Contraseña actualizada', 'Mot de passe mis à jour', 'Senha atualizada'],
  'Alerts saved': ['Waarschuwingen opgeslagen', 'Warnungen gespeichert', 'Alertas guardadas', 'Alertes enregistrées', 'Alertas salvos'],
  'Limits saved': ['Limieten opgeslagen', 'Grenzen gespeichert', 'Límites guardados', 'Limites enregistrées', 'Limites salvos'],
  'Integrations saved': ['Integraties opgeslagen', 'Integrationen gespeichert', 'Integraciones guardadas', 'Intégrations enregistrées', 'Integrações salvas'],
  'Server list saved': ['Serverlijst opgeslagen', 'Serverliste gespeichert', 'Lista de servidores guardada', 'Liste des serveurs enregistrée', 'Lista de servidores salva'],
  'Event saved': ['Evenement opgeslagen', 'Ereignis gespeichert', 'Evento guardado', 'Événement enregistré', 'Evento salvo'],
};

const PATTERNS = [
  // "3 of 5 online" on the status pills, "Next 05:00" on schedules
  [/^(\d+) of (\d+) online$/, ['$1 van $2 online', '$1 von $2 online', '$1 de $2 en línea', '$1 sur $2 en ligne', '$1 de $2 online']],
  [/^(\d+) of (\d+)$/, ['$1 van $2', '$1 von $2', '$1 de $2', '$1 sur $2', '$1 de $2']],
];

function pick() {
  let stored = null;
  try {
    stored = localStorage.getItem('gp-lang');
  } catch {
    stored = null;
  }
  if (stored && LANGUAGES.some((l) => l.id === stored)) return stored;
  const browser = String(navigator.language || 'en').toLowerCase().slice(0, 2);
  return LANGUAGES.some((l) => l.id === browser) ? browser : 'en';
}

export const lang = pick();
const col = ORDER.indexOf(lang);

export function setLanguage(id) {
  try {
    localStorage.setItem('gp-lang', id);
  } catch {
    /* private mode */
  }
  location.reload();
}

/** One string: the translation, or the English it came in as. */
export function t(text) {
  if (col < 0 || !text) return text;
  const hit = DICT[text];
  if (hit) return hit[col] || text;
  for (const [re, out] of PATTERNS) if (re.test(text)) return text.replace(re, out[col]);
  return text;
}

// Never translate what came from servers, files or people.
const SKIP = '.console, textarea, pre, code, .mono, .editor, .diff, [translate="no"], script, style, .user-name, .sidebar-server .name, .crumbs, .bell-text, .host-mini, .toast-raw';

function translateText(node) {
  const raw = node.nodeValue;
  const text = raw.trim();
  if (!text || text.length > 120) return;
  const out = t(text);
  if (out !== text) node.nodeValue = raw.replace(text, out);
}

const ATTRS = ['placeholder', 'title', 'aria-label'];

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    if (root.parentElement && !root.parentElement.closest(SKIP)) translateText(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE || root.closest(SKIP)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n);
    else for (const a of ATTRS) if (n.hasAttribute(a)) n.setAttribute(a, t(n.getAttribute(a)));
  }
}

/** Translate the page now and everything drawn into it later. */
export function startTranslating() {
  if (col < 0) return;
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : lang;
  translateTree(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') {
        if (r.target.parentElement && !r.target.parentElement.closest(SKIP)) translateText(r.target);
        continue;
      }
      for (const n of r.addedNodes) translateTree(n);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
