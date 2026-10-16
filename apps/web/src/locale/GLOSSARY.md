# Translation glossary

Product terms are translated the same way everywhere: the web app (`messages.<locale>.json`), the
API's emails and push notifications (`apps/api/src/lib/i18n/messages/`), and the docs. Change a term
here first, then update every use.

## Voice per language

| Locale | Register | Notes |
| --- | --- | --- |
| en-US | Same voice as the UK source | US spelling only: organization, color, canceled, favorite, behavior, center, license, catalog, -ize verbs (customize, organize, recognize). Same words and tone otherwise. |
| es | Informal **tú** | Neutral international Spanish. Sentence case. Use `¿…?` and `¡…!`. |
| pt-BR | **você** | Brazilian Portuguese, not European. Sentence case. |
| fr | Formal **vous** | Sentence case. Put a non-breaking space (U+00A0) before `:` `;` `!` `?` and inside « ». |
| de | Informal **du** | Capitalise nouns. Sentence case for UI labels. Prefer short compounds. Use „…“ quotes. |
| nl | Informal **je/jij** | Dutch. Sentence case. |
| nb | Informal **du** | Norwegian Bokmål. Sentence case. Accept browser `no` preferences as `nb`. |
| zh-CN | Neutral **你** | Simplified Chinese. Use Chinese punctuation and concise labels. Keep product and plan names unchanged. |
| zh-TW | Neutral **你** | Traditional Chinese with Taiwan terminology: 使用者、檔案、連結、設定. No grammatical plural inflection. |
| ja | Polite **です/ます** | No spaces between words. Full-width `。` `、` `（）`. Keep button labels short (verb stem or noun, no です/ます). |

Everywhere:

- Keep **Kanera** untranslated, and keep plan names (**Free**, **Pro**) untranslated.
- Keep every `{$PLACEHOLDER}`, `{PLACEHOLDER}`, `{name}` and ICU keyword (`plural`, `select`,
  `one`, `other`, `=0`) exactly as written. Plural categories can change: Japanese uses only
  `other`. Select keys can't.
- "Observer" is not "watcher": German uses Betrachter for the role because Beobachter is the
  watcher.
- Notification lines follow the person's name, which the UI renders separately. Japanese starts
  them with が ("がこのカードを作成しました"); the API's push wording (`activity` in
  `apps/api/src/lib/i18n/messages/<locale>.ts`) matches the web drawer, minus that particle.
- Keep keyboard keys (`Ctrl`, `Shift`, `Esc`, `Enter`), file types, units and code unchanged.
- Translate the meaning, not the words. UI labels stay short. If a literal translation would
  overflow a button, use the shorter natural term.

## Terms

| English (UK source) | en-US | es | pt-BR | fr | de | ja | nl | nb | zh-CN | zh-TW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| organisation | organization | organización | organização | organisation | Organisation | 組織 | organisatie | organisasjon | 组织 | 組織 |
| workspace | workspace | espacio de trabajo | espaço de trabalho | espace de travail | Arbeitsbereich | ワークスペース | werkruimte | arbeidsområde | 工作区 | 工作區 |
| board | board | tablero | quadro | tableau | Board | ボード | bord | tavle | 看板 | 看板 |
| standalone board | standalone board | tablero independiente | quadro independente | tableau autonome | eigenständiges Board | 独立ボード | zelfstandig bord | selvstendig tavle | 独立看板 | 獨立看板 |
| board group | board group | grupo de tableros | grupo de quadros | groupe de tableaux | Board-Gruppe | ボードグループ | bordgroep | tavlegruppe | 看板分组 | 看板分組 |
| guest board | guest board | tablero de invitado | quadro de convidado | tableau invité | Gast-Board | ゲストボード | gastbord | gjestetavle | 访客看板 | 訪客看板 |
| list | list | lista | lista | liste | Liste | リスト | lijst | liste | 列表 | 列表 |
| card | card | tarjeta | cartão | carte | Karte | カード | kaart | kort | 卡片 | 卡片 |
| card key | card key | clave de tarjeta | chave do cartão | clé de carte | Kartenschlüssel | カードキー | kaartsleutel | kortnøkkel | 卡片标识 | 卡片標識 |
| label | label | etiqueta | etiqueta | étiquette | Label | ラベル | label | etikett | 标签 | 標籤 |
| checklist | checklist | lista de verificación | checklist | checklist | Checkliste | チェックリスト | checklist | sjekkliste | 检查清单 | 檢查清單 |
| checklist item | checklist item | elemento de la lista | item da checklist | élément de checklist | Checklistenpunkt | チェックリスト項目 | checklistitem | sjekklistepunkt | 清单项 | 清單項 |
| custom field | custom field | campo personalizado | campo personalizado | champ personnalisé | benutzerdefiniertes Feld | カスタムフィールド | aangepast veld | egendefinert felt | 自定义字段 | 自訂欄位 |
| description | description | descripción | descrição | description | Beschreibung | 説明 | beschrijving | beskrivelse | 描述 | 描述 |
| due date | due date | fecha de vencimiento | data de entrega | date d'échéance | Fälligkeitsdatum | 期限 | vervaldatum | frist | 截止日期 | 截止日期 |
| start date | start date | fecha de inicio | data de início | date de début | Startdatum | 開始日 | startdatum | startdato | 开始日期 | 開始日期 |
| overdue | overdue | vencida | atrasado | en retard | überfällig | 期限切れ | achterstallig | forfalt | 已逾期 | 已逾期 |
| assignee | assignee | responsable | responsável | responsable | zugewiesene Person | 担当者 | toegewezen persoon | ansvarlig | 负责人 | 負責人 |
| assign | assign | asignar | atribuir | assigner | zuweisen | 割り当てる | toewijzen | tilordne | 分配 | 分配 |
| watch / watcher | watch / watcher | seguir / seguidor | acompanhar / seguidor | suivre / abonné | beobachten / Beobachter | ウォッチ / ウォッチャー | volgen / volger | følge / følger | 关注 / 关注者 | 關注 / 關注者 |
| mention | mention | mención | menção | mention | Erwähnung | メンション | vermelding | omtale | 提及 | 提及 |
| comment | comment | comentario | comentário | commentaire | Kommentar | コメント | reactie | kommentar | 评论 | 評論 |
| reaction | reaction | reacción | reação | réaction | Reaktion | リアクション | reactie | reaksjon | 表情回应 | 表情回應 |
| attachment | attachment | archivo adjunto | anexo | pièce jointe | Anhang | 添付ファイル | bijlage | vedlegg | 附件 | 附件 |
| cover | cover | portada | capa | couverture | Titelbild | カバー | omslag | forside | 封面 | 封面 |
| activity | activity | actividad | atividade | activité | Aktivität | アクティビティ | activiteit | aktivitet | 动态 | 動態 |
| archive (verb) / archived | archive / archived | archivar / archivada | arquivar / arquivado | archiver / archivée | archivieren / archiviert | アーカイブする / アーカイブ済み | archiveren / gearchiveerd | arkivere / arkivert | 归档 / 已归档 | 歸檔 / 已歸檔 |
| complete (verb) / completed | complete / completed | completar / completada | concluir / concluído | terminer / terminée | abschließen / erledigt | 完了する / 完了 | voltooien / voltooid | fullføre / fullført | 完成 / 已完成 | 完成 / 已完成 |
| completed cards | completed cards | tarjetas completadas | cartões concluídos | cartes terminées | erledigte Karten | 完了したカード | voltooide kaarten | fullførte kort | 已完成卡片 | 已完成卡片 |
| separator | separator | separador | separador | séparateur | Trennlinie | 区切り線 | scheidingslijn | skillelinje | 分隔线 | 分隔線 |
| mirror (board mirror) | mirror | espejo | espelho | miroir | Spiegelung | ミラー | spiegel | speiling | 镜像 | 鏡像 |
| automation | automation | automatización | automação | automatisation | Automatisierung | オートメーション | automatisering | automatisering | 自动化 | 自動化 |
| template | template | plantilla | modelo | modèle | Vorlage | テンプレート | sjabloon | mal | 模板 | 模板 |
| reminder | reminder | recordatorio | lembrete | rappel | Erinnerung | リマインダー | herinnering | påminnelse | 提醒 | 提醒 |
| notification | notification | notificación | notificação | notification | Benachrichtigung | 通知 | melding | varsel | 通知 | 通知 |
| daily digest | daily digest | resumen diario | resumo diário | récapitulatif quotidien | tägliche Zusammenfassung | デイリーダイジェスト | dagelijks overzicht | daglig sammendrag | 每日摘要 | 每日摘要 |
| Home (page) | Home | Inicio | Início | Accueil | Start | ホーム | Start | Hjem | 首页 | 首頁 |
| My Cards (page) | My Cards | Mis tarjetas | Meus cartões | Mes cartes | Meine Karten | マイカード | Mijn kaarten | Mine kort | 我的卡片 | 我的卡片 |
| Team Cards (page) | Team Cards | Tarjetas del equipo | Cartões da equipe | Cartes de l'équipe | Team-Karten | チームのカード | Teamkaarten | Teamkort | 团队卡片 | 團隊卡片 |
| Portfolio (page) | Portfolio | Portafolio | Portfólio | Portefeuille | Portfolio | ポートフォリオ | Portfolio | Portefølje | 项目总览 | 專案總覽 |
| Priorities | Priorities | Prioridades | Prioridades | Priorités | Prioritäten | 優先事項 | Prioriteiten | Prioriteringer | 优先事项 | 優先事項 |
| Notes | Notes | Notas | Notas | Notes | Notizen | ノート | Notities | Notater | 笔记 | 筆記 |
| Scratchpad | Scratchpad | Bloc de notas | Bloco de rascunho | Bloc-notes | Notizblock | スクラッチパッド | Kladblok | Kladd | 草稿本 | 草稿本 |
| Work done | Work done | Trabajo realizado | Trabalho concluído | Travail accompli | Erledigte Arbeit | 完了した作業 | Voltooid werk | Utført arbeid | 已完成工作 | 已完成工作 |
| board view / table view / calendar view | (same) | vista de tablero / de tabla / de calendario | visualização em quadro / tabela / calendário | vue tableau / table / calendrier | Board- / Tabellen- / Kalenderansicht | ボード / テーブル / カレンダー表示 | bordweergave / tabelweergave / kalenderweergave | tavlevisning / tabellvisning / kalendervisning | 看板视图 / 表格视图 / 日历视图 | 看板檢視 / 表格檢視 / 日曆檢視 |
| In progress (list marking) / In progress list | In progress / In progress list | En curso / lista En curso | Em andamento / lista Em andamento | En cours / liste En cours | In Arbeit / In-Arbeit-Liste | 進行中 / 進行中リスト | In uitvoering / lijst In uitvoering | Pågår / Pågår-liste | 进行中 / 进行中列表 | 進行中 / 進行中列表 |
| time in progress (tracked working time) | time in progress | tiempo en curso | tempo em andamento | temps en cours | Zeit in Arbeit | 進行中の時間 | tijd in uitvoering | tid i arbeid | 进行中时长 | 進行中時長 |
| filter | filter | filtro | filtro | filtre | Filter | フィルター | filter | filter | 筛选 | 篩選 |
| group by | group by | agrupar por | agrupar por | regrouper par | gruppieren nach | グループ化 | groeperen op | grupper etter | 分组依据 | 分組依據 |
| sort | sort | ordenar | ordenar | trier | sortieren | 並べ替え | sorteren | sorter | 排序 | 排序 |
| Up next (personal queue) | Up next | Próximas | A seguir | À suivre | „Als Nächstes“ | 次にやること | Hierna | Neste | 接下来 | 接下來 |
| Not queued (open cards outside Up next) | Not queued | Fuera de Próximas | Fora de A seguir | Hors À suivre | Nicht eingereiht | 未追加 | Niet in Hierna | Ikke i Neste | 未加入 | 未加入 |
| editor / observer (board roles) | editor / observer | editor / observador | editor / observador | éditeur / observateur | Bearbeiter / Betrachter | 編集者 / 閲覧者 | bewerker / waarnemer | redaktør / observatør | 编辑者 / 观察者 | 編輯者 / 觀察者 |
| trigger / action (automation) | trigger / action | desencadenante / acción | gatilho / ação | déclencheur / action | Auslöser / Aktion | トリガー / アクション | trigger / actie | utløser / handling | 触发条件 / 操作 | 觸發條件 / 操作 |
| source / target (mirror) | source / target | origen / destino | origem / destino | source / cible | Quelle / Ziel | コピー元 / コピー先 | bron / doel | kilde / mål | 来源 / 目标 | 來源 / 目標 |
| board linking | board linking | vinculación de tableros | vinculação de quadros | liaison de tableaux | Board-Verknüpfung | ボードのリンク | bordkoppeling | tavlekobling | 看板关联 | 看板關聯 |
| saved view | saved view | vista guardada | visualização salva | vue enregistrée | gespeicherte Ansicht | 保存したビュー | opgeslagen weergave | lagret visning | 已保存视图 | 已保存檢視 |
| quick edit | quick edit | edición rápida | edição rápida | modification rapide | Schnell bearbeiten | クイック編集 | snel bewerken | hurtigredigering | 快速编辑 | 快速編輯 |
| unassign | unassign | quitar la asignación | remover atribuição | désassigner | Zuweisung aufheben | 割り当てを解除 | toewijzing verwijderen | fjern tilordning | 取消分配 | 取消分配 |
| bulk actions | bulk actions | acciones en bloque | ações em massa | actions groupées | Massenaktionen | 一括操作 | bulkacties | massehandlinger | 批量操作 | 批量操作 |
| unattended agent | unattended agent | agente desatendido | agente autônomo | agent autonome | unbeaufsichtigter Agent | 無人エージェント | onbeheerde agent | ubemannet agent | 无人值守代理 | 無人值守代理 |
| self-hosted / deployment | self-hosted / deployment | autoalojado / instalación | auto-hospedado / instalação | auto-hébergé / installation | selbst gehostet / Installation | セルフホスト / 環境 | zelfgehost / implementatie | selvhostet / utrulling | 自托管 / 部署 | 自托管 / 部署 |
| member | member | miembro | membro | membre | Mitglied | メンバー | lid | medlem | 成员 | 成員 |
| guest | guest | invitado | convidado | invité | Gast | ゲスト | gast | gjest | 访客 | 訪客 |
| owner | owner | propietario | proprietário | propriétaire | Inhaber | オーナー | eigenaar | eier | 所有者 | 所有者 |
| admin | admin | administrador | administrador | administrateur | Admin | 管理者 | beheerder | administrator | 管理员 | 管理員 |
| invite / invitation | invite / invitation | invitar / invitación | convidar / convite | inviter / invitation | einladen / Einladung | 招待する / 招待 | uitnodigen / uitnodiging | inviter / invitasjon | 邀请 / 邀请 | 邀請 / 邀請 |
| seat (billing) | seat | puesto | licença | siège | Lizenz | シート | licentie | lisens | 席位 | 席位 |
| trial | trial | prueba | avaliação | essai | Testphase | トライアル | proefperiode | prøveperiode | 试用 | 試用 |
| plan | plan | plan | plano | forfait | Tarif | プラン | abonnement | abonnement | 订阅方案 | 訂閱方案 |
| API key | API key | clave de API | chave de API | clé API | API-Schlüssel | APIキー | API-sleutel | API-nøkkel | API 密钥 | API 密鑰 |
| AI agent | AI agent | agente de IA | agente de IA | agent IA | KI-Agent | AIエージェント | AI-agent | KI-agent | AI 代理 | AI 代理 |
| run (agent run) | run | ejecución | execução | exécution | Ausführung | 実行 | uitvoering | kjøring | 运行 | 運行 |
| sign in / log in | sign in / log in | iniciar sesión | entrar | se connecter | anmelden | ログイン | inloggen | logg inn | 登录 | 登錄 |
| sign up | sign up | registrarse | criar conta | s'inscrire | registrieren | 新規登録 | registreren | registrer deg | 注册 | 註冊 |
| log out | log out | cerrar sesión | sair | se déconnecter | abmelden | ログアウト | uitloggen | logg ut | 退出登录 | 退出登錄 |
| settings | settings | configuración | configurações | paramètres | Einstellungen | 設定 | instellingen | innstillinger | 设置 | 設定 |
| two-factor authentication | two-factor authentication | verificación en dos pasos | autenticação de dois fatores | authentification à deux facteurs | Zwei-Faktor-Authentifizierung | 二要素認証 | tweefactorauthenticatie | tofaktorautentisering | 双重验证 | 雙重驗證 |
| storage | storage | almacenamiento | armazenamento | stockage | Speicher | ストレージ | opslag | lagring | 存储 | 儲存 |
| import | import | importar | importar | importer | importieren | インポート | importeren | importer | 导入 | 匯入 |
| export | export | exportar | exportar | exporter | exportieren | エクスポート | exporteren | eksporter | 导出 | 匯出 |
