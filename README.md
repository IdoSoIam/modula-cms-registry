# Modula CMS Registery

Registre central Cloudflare pour :

- templates versionnés
- assets de templates
- releases applicatives
- enregistrement d’instances
- jobs de déploiement

## Démarrage

1. Créer la base D1 et le bucket R2.
2. Remplacer les bindings dans [wrangler.jsonc](D:/Works/modula-cms-registery/wrangler.jsonc).
3. Définir les clés d’API dans `API_KEYS_JSON`.
4. Appliquer les migrations :

```bash
npm run db:migrate:local
```

5. Lancer :

```bash
npm run dev
```
