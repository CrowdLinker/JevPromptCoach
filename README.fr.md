<div align="center">

<img src="assets/banner.png" alt="Jev (Prompt Coach) - laissez Jev de TypeSafe AI devenir votre coach de prompts" width="860">

<p>
  <a href="https://github.com/CrowdLinker/JevPromptCoach/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/CrowdLinker/JevPromptCoach/ci.yml?branch=main&style=flat-square&labelColor=0b0f17&color=3fb950&label=CI"></a>
  <img alt="Node 22 ou plus recent" src="https://img.shields.io/badge/node-22%2B-0b0f17?style=flat-square">
  <img alt="Licence MIT" src="https://img.shields.io/badge/licence-MIT-0b0f17?style=flat-square">
</p>

[English](README.md) · **Français** · [Español](README.es.md)

</div>

Évalue la qualité des prompts que vous écrivez à un agent de codage, et montre
si vos habitudes progressent. Fonctionne sur le modèle Jev de
[TypeSafe](https://typesafe.ai).

Il n'ajoute rien au délai entre le moment où vous appuyez sur Entrée et la
réponse de l'agent.

> **Plugin communautaire non officiel.** Sans affiliation avec TypeSafe ou
> Anthropic, ni approbation ni support de leur part. Vous fournissez votre
> propre clé d'API TypeSafe.

---

## Pourquoi ce plugin existe

La plupart des outils de qualité de prompt placent un modèle de langage entre
vous et votre agent. Ils notent le prompt avant son envoi, ce qui impose un
aller-retour réseau à chaque message.

Jev (Prompt Coach) ne se met pas là. Dans son mode par défaut, le hook ajoute
une ligne à un fichier local et se termine. La notation a lieu quand vous la
demandez, dans une commande.

La deuxième différence : il note les prompts que vous avez **déjà écrits**. Un
rattrapage sur une année d'historique local de Claude Code coûte environ six
cents, parce que Jev facture 0,042 $ par million de tokens en entrée et rien en
sortie. Vous obtenez un rapport dès le premier jour au lieu d'attendre deux
semaines.

## Prérequis

- **Node 22 ou plus récent** — `node --version`
- **Claude Code 2.1.x ou plus récent.** Les hooks `UserPromptSubmit` déclarés
  par un plugin ne s'exécutaient pas sur certaines versions antérieures, et le
  plugin en dépend.
- **Une clé d'API TypeSafe**, depuis
  [console.typesafe.ai](https://console.typesafe.ai/settings/keys).

Le plugin embarque ses propres dépendances dans `dist/`. Aucune étape
d'installation, aucun `node_modules`, rien de téléchargé à l'exécution, et le
seul hôte qu'il contacte est `api.typesafe.ai`.

Claude Code est un binaire natif et n'embarque pas de Node : c'est le Node de
votre `PATH` qui exécute le hook. Node 22 est le plancher, et la CI teste 22 et
24.

## Installation

**1. Ajoutez la marketplace et installez le plugin.**

```
claude plugin marketplace add CrowdLinker/JevPromptCoach
claude plugin install jevpromptcoach@jevpromptcoach
```

Vérifiez le chargement — le statut doit être `enabled` :

```
claude plugin list
```

**2. Donnez-lui votre clé d'API.**

Créez d'abord le fichier, restreignez ses droits, et seulement ensuite mettez la
clé dedans — ainsi la clé n'existe jamais dans un fichier lisible par tous, et
n'apparaît jamais sur une ligne de commande que votre shell enregistrerait dans
son historique :

```
mkdir -p ~/.claude/jevpromptcoach
touch ~/.claude/jevpromptcoach/.env
chmod 600 ~/.claude/jevpromptcoach/.env
```

Ouvrez ensuite `~/.claude/jevpromptcoach/.env` dans votre éditeur et ajoutez une
ligne :

```
TYPESAFE_API_KEY=votre-cle-ici
```

C'est là que le plugin cherche la clé. Un hook ne s'exécute pas sous votre
profil de shell, donc une clé exportée uniquement dans `.zshrc` peut ne jamais
lui parvenir, et le mode `always` en a besoin ici. Le plugin n'écrit jamais ce
fichier, ne journalise jamais la clé, et ne la laisse jamais entrer dans un
message d'erreur.

`TYPESAFE_API_KEY` dans l'environnement reste prioritaire si vous avez une
raison de le définir — c'est ainsi que la CI et l'eval la fournissent — mais le
fichier est ce qu'il faut utiliser au quotidien.

**3. Vérifiez que cela fonctionne.**

```
/jevpromptcoach:config
```

Cela affiche votre mode, votre niveau de confidentialité, si la clé a été
trouvée, et combien de prompts ont été journalisés. Envoyez un ou deux prompts
puis relancez la commande — si le compteur ne monte pas, le hook ne se déclenche
pas, et [docs/HOOK-BEHAVIOUR.md](docs/HOOK-BEHAVIOUR.md) explique pourquoi (en
anglais).

## Configuration

**Choisissez un mode.** Le défaut est `on-demand`, qui n'ajoute jamais de
latence. Ne changez que si vous voulez une note sur chaque message :

```
/jevpromptcoach:config mode always
```

**Choisissez un niveau de confidentialité.** Le défaut est `redact`. Si les
prompts de votre travail ne doivent jamais quitter la machine :

```
/jevpromptcoach:config privacy metadata_only
```

**Rattrapez votre historique.** C'est ce qui vaut la peine dès le premier jour :

```
/jevpromptcoach:config backfill
```

La commande indique combien de prompts elle a trouvés et ce qu'ils coûteront, et
n'envoie rien avant votre confirmation. Sur 1 039 prompts, cela a coûté 0,06 $.

Puis :

```
/jevpromptcoach:report
```

**Désinstallation.** `claude plugin uninstall jevpromptcoach@jevpromptcoach`
retire le plugin mais laisse vos données. Pour les supprimer aussi, effacez
`~/.claude/jevpromptcoach/`.

## Commandes

Les commandes de plugin sont préfixées, et le préfixe n'est pas toujours
optionnel — un agent lancé via Task ou `@mention` ne sait pas résoudre la forme
courte. Écrivez toujours le nom complet.

### `/jevpromptcoach:score <texte>`

Note un brouillon **avant** que vous ne l'envoyiez. C'est la surface
pédagogique : elle affiche la note, chaque vérification en réussite / échec /
non applicable, et pour chaque échec la cause, la conséquence et la correction —
puis réécrit *votre* texte pour qu'il passe.

Sans argument, elle s'explique et montre un exemple. Elle ne renvoie pas
d'erreur.

### `/jevpromptcoach:report [N]`

Les tendances sur les N derniers prompts journalisés, 200 par défaut. Taux de
réussite par vérification, tendance sur 30 jours, et **une** habitude à
travailler. Pas sept.

Voir [docs/EXAMPLE-REPORT.md](docs/EXAMPLE-REPORT.md) pour un rapport réel,
généré sur 1 040 prompts d'historique (en anglais).

### `/jevpromptcoach:config`

Mode, niveau de confidentialité, rattrapage, et effacement du journal.

```
/jevpromptcoach:config                      affiche les réglages actuels
/jevpromptcoach:config mode always          note en ligne au fil de l'eau
/jevpromptcoach:config privacy metadata_only
/jevpromptcoach:config backfill             estimation, puis confirmation
/jevpromptcoach:config clear                supprime le journal local
```

## Les sept vérifications

Des habitudes propres aux agents de codage, pas du prompt engineering générique.
Les sept voyagent dans **une seule** requête Jev par prompt.

| Vérification | Ce qu'elle cherche |
| --- | --- |
| Nomme le fichier ou la fonction | Un vrai nom, pas "le code" ni "ça" |
| Dit à quoi ressemble "terminé" | Ce qui doit être vrai une fois le travail fini |
| S'en tient à une seule exigence | Un changement concret, pas plusieurs empaquetés |
| Dit ce qui ne doit pas changer | Ce qui doit rester en l'état |
| Donne l'erreur réelle | Le texte de l'erreur, ou attendu contre obtenu |
| Demande un plan d'abord | Voir l'approche avant un changement risqué |
| Donne les étapes de vérification | Le test ou la commande qui le prouverait |

Deux sont conditionnelles : l'erreur réelle n'est évaluée que sur les rapports de
bug, et le plan d'abord uniquement sur les demandes larges ou destructrices. Le
reste est marqué `n/a` plutôt que compté comme un échec.

Ne sont pas notés du tout : les commandes slash, les réponses d'un mot, tout ce
qui fait moins de 15 caractères, et les messages injectés par Claude Code.

## Les deux modes

### `on-demand` (défaut) — zéro latence ajoutée

Le hook ajoute une ligne à un journal JSONL local et se termine avec le code 0.
Aucun appel réseau, aucun import du client Jev.

Coût mesuré : **27 à 31 ms** par prompt, dont environ 20 ms de démarrage du
processus Node. C'est entièrement hors du chemin réseau.

### `always` — une notice courte, non bloquante

Le hook note aussi le prompt et affiche une notice courte pendant que le prompt
poursuit sa route.

Garanties :

- **Jamais de code de sortie 2.** Sur `UserPromptSubmit`, le code 2 bloque le
  prompt et *efface ce que vous avez tapé*. Tous les chemins d'échec sortent
  avec 0.
- **Un délai maximum strict** (4 s par défaut). Si Jev ne répond pas à temps,
  rien ne s'affiche.
- **`*` contourne.** Un prompt qui commence par `*` n'est ni journalisé ni noté.
- **Seulement les constats défendables.** Deux vérifications sont exclues de la
  ligne en ligne sur la base des preuves de l'eval, et tout ce qui est proche
  d'un seuil est écarté plutôt qu'affiché.
- **Pas de 0/100.** Quand aucune vérification décidée ne passe, la notice
  indique ce qui manque, sans le chiffre.

**Les relances sont lues en contexte.** Le premier prompt d'une session est noté
seul. Un prompt suivant est envoyé avec les deux prompts qui le précèdent dans la
même session, et seul le nouveau est noté. Activé par défaut ;
`JEVPROMPTCOACH_SESSION_CONTEXT=0` le désactive. Les seuils ont été calibrés sur
des prompts notés seuls.

**Les réponses de Claude, sur demande.** Avec `JEVPROMPTCOACH_SESSION_REPLIES=1`,
une relance est envoyée avec les deux derniers échanges (vos prompts et le texte
final des réponses de Claude, jamais les outils ni leurs sorties), et chaque
vérification est posée dans sa forme conversationnelle. Un échange contourné par
`*` est retiré avec sa réponse. Désactivé par défaut. Tant que ces vérifications
n'ont pas été calibrées, rien ne s'affiche en ligne.

## Confidentialité

Les prompts contiennent du code, des chemins, et parfois des secrets.

**Le journal est local.** `~/.claude/jevpromptcoach/`, en mode `0600`. Rien ne
quitte votre machine en dehors d'une commande que vous avez lancée.

| Niveau | Ce qui est stocké et envoyé |
| --- | --- |
| `redact` (défaut) | Le texte du prompt, identifiants, adresses e-mail et segments de chemin identifiants retirés. Les noms de fichiers subsistent. |
| `metadata_only` | Uniquement des caractéristiques dérivées — longueur, nombre de mots, présence d'un bloc de code, présence d'un chemin. Jamais le texte. La notation a besoin du texte, donc ce niveau la désactive. |
| `raw` | Le texte tel qu'écrit. Les chaînes en forme d'identifiant sont **quand même** retirées. |

Retiré à tous les niveaux, y compris `raw` : `sk-`, `sk-ant-`, `sk-proj-`,
`ghp_` et apparentés, `AKIA`/`ASIA`, `AIza`, les `xox*` de Slack, les JWT, les
blocs PEM, les secrets clients Azure, les jetons `Bearer`, et tout ce qui est
assigné à un nom finissant par `KEY`/`TOKEN`/`SECRET`/`PASSWORD`.

**Ce qui est envoyé, et quand :**

| Quand | Ce qui part vers `api.typesafe.ai` |
| --- | --- |
| `/jevpromptcoach:score` | Le seul prompt que vous avez passé, expurgé |
| `/jevpromptcoach:report` | Les prompts journalisés pas encore notés, expurgés, par lots |
| `config backfill` | Votre historique, expurgé, par lots — **après** une estimation de coût et une confirmation explicite |
| mode `always` | Chaque prompt au moment où vous l'envoyez, expurgé, plus jusqu'à deux prompts précédents de la même session comme contexte, expurgés eux aussi |
| mode `always`, réponses activées | Idem, mais le contexte est les deux derniers échanges : vos prompts et le texte final des réponses de Claude, expurgés. Seulement avec `JEVPROMPTCOACH_SESSION_REPLIES=1` |
| Sinon, jamais | Rien |

Aucune télémétrie. Aucune autre destination réseau. La clé d'API est lue depuis
l'environnement ou le fichier de clé, et n'est jamais journalisée, affichée, ni
incluse dans un message d'erreur.

Un prompt n'est noté qu'une fois. Les résultats sont mis en cache par empreinte
du contenu, sauf pour une relance en mode `always`, dont le contexte change.

## Contribuer

[CONTRIBUTING.md](CONTRIBUTING.md) donne le détail (en anglais). Deux règles sont
absolues : **aucun identifiant et aucun texte de prompt n'atteint jamais un
commit** — ni le vôtre ni celui de quelqu'un d'autre.

C'est vérifié plutôt que demandé. `scripts/check-leaks.mjs` s'exécute comme hook
de pré-commit, dans `npm test`, et de nouveau en CI sur chaque pull request.

---

> **Référence complète en anglais.** Ce document couvre l'installation et
> l'usage. Les mesures d'eval par vérification et leur validation croisée, le
> signal de résultat mesuré puis écarté, le comportement réel de l'API de hooks
> de Claude Code, et les raisons pour lesquelles `dist/` est commité sans
> lockfile sont dans [README.md](README.md). C'est la référence : en cas de
> divergence, c'est lui qui fait foi.

## Licence

MIT, pour le code. Voir [LICENSE](LICENSE).

Les noms et les logos n'y sont pas inclus — forkez le code, mais renommez le
fork et retirez-en la marque Crowdlinker. TypeSafe, Jev, Claude et Claude Code
appartiennent à leurs propriétaires respectifs. [TRADEMARKS.md](TRADEMARKS.md)
précise qui revendique quoi (en anglais).

---

<div align="center">

<a href="https://crowdlinker.com"><img src="assets/made-by-crowdlinker.png" alt="Créé avec amour par Crowdlinker" width="250"></a>

<sub>Des mesures, pas des impressions. Si un chiffre est faux ici, ouvrez une issue avec ce que vous avez mesuré.</sub>

</div>
