# Le Bac à Sable — multijoueur

Prototype web du jeu de petit bac avec salles en temps réel.

## Fonctionnalités présentes
- Création de salle privée avec code et invitation de 2 à 8 joueurs.
- Reconnexion Socket.IO à l'état de connexion (si la salle existe toujours).
- Lettre commune, chronomètre serveur, soumission des réponses et résultats.
- Scores et pièces traités côté serveur.
- Chat de salle et messages privés.
- Boutique de pouvoirs, inventaire limité à 2 pouvoirs.
- Classement de la partie.
- Interface responsive pour ordinateur et téléphone.

## Limites actuelles
- Les salles et les scores sont stockés en mémoire : ils disparaissent quand le serveur redémarre. Il n'y a pas de compte persistant ni de base de données.
- La validation vérifie la première lettre, mais ne vérifie pas que le mot correspond vraiment à la catégorie.
- Les pouvoirs sont une première version de démonstration et doivent être équilibrés/testés.
- Pour une utilisation publique, ajoutez une validation plus robuste, une protection anti-spam, des tests et éventuellement une base de données.

## Tester sur son ordinateur
Prérequis : Node.js 20 ou plus récent.

```bash
npm install
npm start
```

Puis ouvrir http://localhost:3000 dans deux fenêtres ou deux navigateurs. Pour tester depuis un autre appareil sur le même Wi-Fi, utiliser l'adresse IP locale de l'ordinateur qui exécute le serveur, suivie de `:3000`.

## Publier gratuitement avec GitHub + Render
1. Créer un dépôt GitHub et y téléverser **tous les fichiers** de ce dossier (`server.js`, `package.json`, dossier `public/`, `README.md`).
2. Sur https://render.com, créer un compte et choisir **New → Web Service**.
3. Connecter le dépôt GitHub.
4. Configuration :
   - Runtime / Language : Node
   - Build Command : `npm install`
   - Start Command : `npm start`
   - Instance Type : Free, si disponible pour ton compte/région
5. Déployer et attendre la fin du déploiement. Render fournit une adresse `https://...onrender.com`.
6. Ouvrir cette adresse sur deux appareils, créer une salle depuis le premier, puis rejoindre avec le code depuis le second.

Le serveur sert également la page du jeu, donc **Vercel n'est pas nécessaire** pour cette première version.

## Notes
- Les offres gratuites d'hébergement peuvent changer et les services gratuits peuvent se mettre en veille.
- Ne mets pas de mot de passe, jeton secret ou clé privée dans le dépôt public.
- Le endpoint `/health` renvoie `{ "ok": true }` pour vérifier le service.
