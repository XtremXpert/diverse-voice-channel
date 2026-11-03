# Plan de sécurisation — accès distant au harnais

Objectif : que `https://harnais.636.vezina.biz` soit protégé par une authentification
unique, vérifiable et révocable, sans secret recopié dans le cluster ni jeton à récupérer
à chaque démarrage.

## État actuel (constaté)

- `basicAuth` Traefik devant la route, identifiants dans `lan/harnais-basicauth`.
- Jeton du harnais à usage unique, par démarrage, transmis par `?token=`, puis cookie navigateur.
- Serveur lié à une adresse LAN concrète (refus de `0.0.0.0` par conception).
- Deux essais retirés : injection de cookie par Traefik (rejetée par le harnais) et
  `ipAllowList` (adresse source instable → 403 erratiques).

## Phase 0 — Durcir sans changer d'architecture (1 h)

1. Ajouter `rateLimit` sur la route (ex. 20 req/s, burst 40) contre le bourrage d'identifiants.
2. Activer les **logs d'accès** Traefik et les conserver 30 jours.
3. Vérifier que le port 3080 n'est joignable que depuis le sous-réseau (pare-feu macOS).
4. Rotation du mot de passe `basicAuth` : le régénérer et mettre à jour le secret.
5. Documenter la procédure de coupure d'urgence (`kubectl delete ingressroute harnais -n lan`).

### État de la phase 0

| Point | État |
|---|---|
| `rateLimit` (20 req/s, burst 40) | appliqué sur la route ; **429 non reproduit** en test, à revérifier |
| Journalisation des accès Traefik | **non activée** — nécessite un `HelmChartConfig` pour le chart rke2-traefik |
| Restriction du port 3080 | pare-feu macOS désactivé ; le serveur ne binde que l'adresse LAN |
| Rotation du mot de passe | faite (secret `lan/harnais-basicauth` remplacé) |
| Procédure de coupure d'urgence | documentée dans `KNOWLEDGE-harnais.md` |

**Logs d'accès : tentative abandonnée.** Appliquer un `HelmChartConfig` sur `rke2-traefik`
a fait repasser le Service Traefik en `ClusterIP` à deux reprises, coupant **tous** les
services exposés (Odoo, docs, harnais). Réparation immédiate appliquée :

```sh
kubectl -n kube-system patch svc rke2-traefik --type merge -p '{"spec":{"type":"LoadBalancer"}}'
```

Ne pas retenter sans banc d'essai : le chart rke2 recompose le Service à chaque
réconciliation, et la valeur `service.spec.loadBalancerIP` n'est pas honorée comme attendu.
Alternative à évaluer : collecter les logs via un agent (Promtail/Fluent Bit) sur les pods
Traefik, sans toucher au chart.

## Phase 1 — Authentification unique (demi-journée)

Objectif : supprimer la double saisie et le jeton manuel.

1. Déployer **Authelia** (ou un `forwardAuth` équivalent) dans le cluster.
2. Traefik : remplacer `harnais-auth` par un middleware `forwardAuth` vers Authelia.
3. Déclarer l'utilisateur `benoit` avec mot de passe fort + TOTP (second facteur).
4. Conserver `basicAuth` en secours, désactivé par défaut.

Livrable : une seule page de connexion, 2FA, sessions révocables.

## Phase 2 — Supprimer la dépendance au jeton (1 journée)

Le harnais exige son jeton ; deux voies, par ordre de préférence.

1. **Amont** : proposer un mode `--trusted-proxy` (ou l'acceptation d'un en-tête
   `X-Auth-User` fourni par le `forwardAuth`) afin de désactiver le jeton quand la
   requête vient d'un proxy authentifié. C'est la solution propre, réutilisable.
2. **Repli local** : un agent launchd écrit le jeton courant dans l'annotation de
   l'IngressRoute et l'edge redirige `/` vers `/?token=…`. Fonctionne, mais recopie un
   secret dans le cluster : à ne garder que si l'amont n'est pas possible.

Critère de sortie : aucun jeton à récupérer manuellement, aucune valeur secrète dans un
objet Kubernetes.

## Phase 3 — Traçabilité et réaction (demi-journée)

1. Journaliser les authentifications (succès, échecs) avec IP et agent.
2. Alerter sur plus de 5 échecs en 5 minutes (Pushover ou courriel).
3. Procédure de révocation : supprimer la session Authelia, régénérer le mot de passe,
   redémarrer le serveur web (jeton invalidé).
4. Revue trimestrielle des accès.

## Phase 4 — Cible long terme

1. **SSO OIDC** (Authentik/Authelia) avec groupes `harnais-admins` / `harnais-lecture`.
2. Secrets gérés dans Vault, jamais dans un manifeste ni un secret Kubernetes en clair.
3. Second hôte en lecture seule si un accès consultation est nécessaire.
4. Sauvegarde et restauration testées de `~/.dsh` (sessions, réglages).

## Risques et parades

| Risque | Parade |
|---|---|
| Mot de passe unique partagé | 2FA + révocation par session |
| Jeton dans un favori ou un historique | jeton à usage unique, cookie navigateur |
| Secret en clair dans le cluster | Phase 2, voie amont |
| Indisponibilité d'Authelia | `basicAuth` conservé en secours |
| Adresse source instable | pas d'`ipAllowList`, filtrage au pare-feu |

## Ordre d'exécution recommandé

Phase 0 → Phase 1 → Phase 3 → Phase 2 → Phase 4.

La Phase 2 arrive après la 3 : la traçabilité doit exister avant de retirer le jeton,
sinon une panne d'authentification devient invisible.
