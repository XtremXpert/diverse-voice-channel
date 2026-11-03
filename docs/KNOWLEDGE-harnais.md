# Accès distant au harnais — harnais.636.vezina.biz

## À quoi ça sert

Le harnais (agent DeepSeek) tourne sur le Mac Studio et n'écoute que sur le réseau local.
Le cluster l'expose en HTTPS sous un nom d'hôte, sans ouvrir le Mac sur Internet.

## Chemin d'une requête

```
navigateur → https://harnais.636.vezina.biz
           → Traefik (192.168.235.115:443)
           → middlewares : harnais-lan-only (ipAllowList) → harnais-auth (basicAuth) → harnais-cookie
           → Service lan/harnais-harness (sans sélecteur)
           → Endpoints : 192.168.235.231:3080 (Mac Studio)
```

## Objets Kubernetes (namespace `lan`)

| Objet | Rôle |
|---|---|
| `Service/harnais-harness` | port 3080, sans sélecteur |
| `Endpoints/harnais-harness` | adresse du Mac |
| `Middleware/harnais-lan-only` | `ipAllowList` 192.168.224.0/20 |
| `Middleware/harnais-auth` | `basicAuth`, secret `lan/harnais-basicauth` |
| `Middleware/harnais-cookie` | injecte le cookie de session du harnais |
| `IngressRoute/harnais` | hôte + entryPoint `websecure` + annotation `kubernetes.io/ingress.class: traefik` |

## Double authentification

1. **Mot de passe** (Traefik) : durable, indépendant du harnais.
2. **Jeton** (harnais) : régénéré à chaque démarrage, transmis **une fois** par l'URL
   `/?token=…`. Le navigateur conserve ensuite son cookie de session ; le jeton n'est plus
   nécessaire pour ce navigateur, même après redémarrage du serveur.

L'injection automatique du cookie par Traefik a été essayée puis retirée : le harnais
rejette un cookie réinjecté hors du contexte qui l'a émis (401 sans en-tête
`WWW-Authenticate`). La capture et la publication du cookie restent dans
`scripts/publish-harnais-cookie.sh`, mais le middleware `harnais-cookie` n'est plus
attaché à la route.

## Exploitation

Déploiement initial :

```sh
export KUBECONFIG=~/.kube/vezina-local.yaml
kubectl apply -f k8s/maison-harness.yaml
kubectl apply -f k8s/harnais-cookie.yaml
```

Démarrage / redémarrage du serveur avec publication du cookie :

```sh
./scripts/refresh-harnais-cookie.sh
```

Automatisation au login (launchd) :

```sh
cp deploy/com.harnais.web.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.harnais.web.plist
```

## Dépannage

| Symptôme | Cause | Action |
|---|---|---|
| `404` | annotation `kubernetes.io/ingress.class` absente, ou middleware invalide (secret manquant) | vérifier l'IngressRoute et ses middlewares |
| `403` | `ipAllowList` refuse la source, ou jeton périmé | vérifier le réseau d'origine ; relancer le script |
| `401` | `basicAuth` refuse, ou le harnais demande son jeton | vérifier le secret `harnais-basicauth` ; relancer le script |
| page vide, `/api` en erreur | `--trusted-host` absent au démarrage du serveur | relancer avec `--trusted-host harnais.636.vezina.biz` |

## Sécurité — état actuel et limite connue

- Le serveur ne binde **jamais** `0.0.0.0` : le harnais refuse cette configuration par conception.
- L'accès est restreint au réseau local **et** protégé par mot de passe.
- **Limite** : le cookie de session est stocké en clair dans l'objet Kubernetes `Middleware/harnais-cookie`,
  lisible par quiconque administre le cluster. Voir la tâche de sécurisation à venir.

## Tâche future — mieux sécuriser

1. Remplacer l'injection de cookie par une authentification de bout en bout
   (`forwardAuth` vers un petit service, ou OIDC Traefik), pour que le harnais ne voie
   que des requêtes déjà autorisées.
2. Rendre la tâche `launchd` supervisée et journalisée (rotation des logs).
3. Ajouter un second facteur sur le `basicAuth` (ou passer à des clés WebAuthn).
4. Restreindre l'`ipAllowList` aux seuls postes réellement utilisés.
5. Auditer les accès via les logs Traefik et alerter en cas d'échec répété.
