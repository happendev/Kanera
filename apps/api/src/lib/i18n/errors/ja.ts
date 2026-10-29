import type { ErrorCatalog } from "./source.js";

// ja translations of the API error catalog. Terms and voice follow apps/web/src/locale/GLOSSARY.md.
export const ja: ErrorCatalog = {
  "external reference already exists": "外部参照はすでに存在します",
  "AI agent access is turned off for this organisation":
    "この組織ではAIエージェントのアクセスが無効になっています。",
  "Additional notification destinations are not available on your plan. Upgrade to configure ntfy, Gotify, or a personal webhook.":
    "追加の通知先はご利用のプランでは使用できません。ntfy、Gotify、または個人用Webhookを設定するにはアップグレードしてください。",
  "All purchased seats are in use. Buy more seats to add this person.":
    "購入済みのシートはすべて使用中です。このユーザーを追加するには、シートを追加購入してください。",
  "An account already exists for this email. Sign in to accept the invite.":
    "このメールアドレスのアカウントはすでに存在します。招待を承諾するにはログインしてください。",
  "Billing cancellation could not be confirmed, so the organisation was not deleted. Please try again.":
    "請求のキャンセルを確認できなかったため、組織は削除されませんでした。もう一度お試しください。",
  "Board syncing requires Pro in both participating organisations.":
    "ボードの同期には、参加する両方の組織でProが必要です。",
  "CSV did not contain any rows":
    "CSVに行が含まれていませんでした。",
  "Device code is invalid or expired":
    "デバイスコードが無効か、有効期限が切れています。",
  "GitHub App is already configured through the deployment environment":
    "GitHub Appはすでにデプロイ環境で設定されています。",
  "GitHub App is configured through the deployment environment":
    "GitHub Appはデプロイ環境で設定されます。",
  "GitHub App is not configured":
    "GitHub Appが設定されていません。",
  "GitHub App manifest could not be completed":
    "GitHub Appのマニフェストを完了できませんでした。",
  "GitHub App not found":
    "GitHub Appが見つかりません。",
  "GitHub App setup is managed by the hosted deployment":
    "GitHub Appの設定はホスト型デプロイで管理されています。",
  "GitHub App user authorization is not configured for this deployment":
    "このデプロイではGitHub Appのユーザー認可が設定されていません。",
  "GitHub installation could not be verified":
    "GitHubのインストールを確認できませんでした。",
  "GitHub installation not found":
    "GitHubのインストールが見つかりません。",
  "GitHub manifest state did not match this organisation":
    "GitHubマニフェストの状態がこの組織と一致しません。",
  "GitHub user authorization could not be verified":
    "GitHubのユーザー認可を確認できませんでした。",
  "GitHub user authorization is required to connect an installation":
    "インストールを接続するにはGitHubのユーザー認可が必要です。",
  "Global Work layout anchors are not available through this API":
    "Global WorkのレイアウトアンカーはこのAPIでは使用できません。",
  "Gotify requires a server URL and app token":
    "GotifyにはサーバーURLとアプリトークンが必要です。",
  "Guests are not available on your plan. Upgrade to invite guests.":
    "ゲストはご利用のプランでは使用できません。ゲストを招待するにはアップグレードしてください。",
  "Idempotency-Key must contain 1 to 255 visible ASCII characters":
    "Idempotency-Keyには1～255文字の表示可能なASCII文字を指定してください。",
  "Idempotency-Key was already used for a different request":
    "このIdempotency-Keyはすでに別のリクエストで使用されています。",
  "Invalid Stripe webhook signature":
    "StripeのWebhook署名が無効です。",
  "Invalid Stripe webhook":
    "StripeのWebhookが無効です。",
  "Kanera export did not contain any lists":
    "Kaneraのエクスポートにリストが含まれていませんでした。",
  "MCP policy applies to hosted organisations only":
    "MCPポリシーはホスト型の組織にのみ適用されます。",
  "MCP subscriptions require an API or OAuth credential":
    "MCPのサブスクリプションにはAPIまたはOAuthの認証情報が必要です。",
  "MFA enrollment is not required":
    "MFAの登録は必要ありません。",
  "MFA is required by this organisation":
    "この組織ではMFAが必須です。",
  "MFA is required by your organisation":
    "ご利用の組織ではMFAが必須です。",
  "No Stripe customer exists for this organisation":
    "この組織のStripe顧客が存在しません。",
  "No Stripe subscription exists for this organisation":
    "この組織のStripeサブスクリプションが存在しません。",
  "No pending seat payment to confirm":
    "確認待ちのシートの支払いはありません。",
  "OAuth connection not found":
    "OAuth接続が見つかりません。",
  "Organisation members are added directly to the board, not invited as guests.":
    "組織のメンバーはゲストとして招待されるのではなく、ボードに直接追加されます。",
  "Seat capacity can only be changed for paid subscriptions":
    "シート数は有料サブスクリプションでのみ変更できます。",
  "Signups are currently disabled.":
    "現在、新規登録は無効になっています。",
  "Stripe did not return a checkout URL":
    "Stripeから決済URLが返されませんでした。",
  "Stripe is not configured":
    "Stripeが設定されていません。",
  "Stripe price is not configured":
    "Stripeの価格が設定されていません。",
  "Stripe webhook secret is not configured":
    "StripeのWebhookシークレットが設定されていません。",
  "The invited boards are no longer available.":
    "招待されたボードは利用できなくなりました。",
  "There is already a pending invite for this email and board.":
    "このメールアドレスとボードには保留中の招待がすでにあります。",
  "This board invitation is invalid or has expired.":
    "このボードへの招待は無効か、有効期限が切れています。",
  "This invitation was sent to a different email address. Sign up with the invited address.":
    "この招待は別のメールアドレスに送信されました。招待されたアドレスで新規登録してください。",
  "This person already has access to this board.":
    "このユーザーはすでにこのボードにアクセスできます。",
  "Trello export did not contain any lists":
    "Trelloのエクスポートにリストが含まれていませんでした。",
  "Update your billing details before adding seats.":
    "シートを追加する前に請求情報を更新してください。",
  "We haven't received confirmation of your payment yet. Complete it and try again.":
    "お支払いの確認がまだ届いていません。お支払いを完了してから、もう一度お試しください。",
  "Webhooks are not available on your plan. Upgrade to create webhooks.":
    "Webhookはご利用のプランでは使用できません。Webhookを作成するにはアップグレードしてください。",
  "Workspace API keys and unattended AI agents are not available on your plan. Upgrade to create them, or use a personal API key or interactive agent connection.":
    "ワークスペースのAPIキーと無人AIエージェントはご利用のプランでは使用できません。作成するにはアップグレードするか、個人用APIキーまたは対話型のエージェント接続を使用してください。",
  "You have more assigned seats than that — remove members or guests first.":
    "割り当て済みのシートがその数を超えています。先にメンバーまたはゲストを削除してください。",
  "Your payment method needs attention before we can add seats. Update your payment method, then try again.":
    "シートを追加する前に、お支払い方法を確認する必要があります。お支払い方法を更新してから、もう一度お試しください。",
  "a board cannot be both a mirror source and a mirror target":
    "ボードをミラーの元と先の両方にすることはできません。",
  "a board cannot mirror itself":
    "ボードを自分自身にミラーすることはできません。",
  "a checklist changed while preparing the batch; retry with fresh content":
    "バッチの準備中にチェックリストが変更されました。最新の内容でもう一度お試しください。",
  "a checklist item changed while applying the batch; retry with fresh content":
    "バッチの適用中にチェックリスト項目が変更されました。最新の内容でもう一度お試しください。",
  "a comment changed while applying the batch; retry with a fresh comment list":
    "バッチの適用中にコメントが変更されました。最新のコメント一覧でもう一度お試しください。",
  "a demo reset is already running":
    "デモのリセットはすでに実行中です。",
  "accessKeyId required":
    "accessKeyIdは必須です。",
  "account disabled":
    "アカウントは無効になっています。",
  "activity cursor does not match this board":
    "アクティビティのカーソルがこのボードと一致しません。",
  "add/remove is only valid for multi-value select or user fields":
    "追加/削除は複数選択フィールドまたはユーザーフィールドでのみ有効です。",
  "administrator not found":
    "管理者が見つかりません。",
  "afterChecklistId not found":
    "afterChecklistIdが見つかりません。",
  "afterItemId not found":
    "afterItemIdが見つかりません。",
  "agent connection not found":
    "エージェント接続が見つかりません。",
  "agent run has already ended":
    "エージェントの実行はすでに終了しています。",
  "agent run not found":
    "エージェントの実行が見つかりません。",
  "an administrator with this email already exists":
    "このメールアドレスの管理者はすでに存在します。",
  "an idempotent request with this key is already in progress":
    "このキーのべき等リクエストはすでに処理中です。",
  "anchor page not found":
    "アンカーページが見つかりません。",
  "api key not found":
    "APIキーが見つかりません。",
  "archived cards are read-only":
    "アーカイブ済みのカードは読み取り専用です。",
  "archived source lists cannot be mirrored":
    "アーカイブ済みの元リストはミラーできません。",
  "archived target lists cannot be selected":
    "アーカイブ済みの先リストは選択できません。",
  "assignee is not an assignable member":
    "担当者は割り当て可能なメンバーではありません。",
  "attachment storage unavailable":
    "添付ファイルのストレージを利用できません。",
  "authorization_code is not allowed for this client":
    "このクライアントではauthorization_codeは許可されていません。",
  "beforeChecklistId not found":
    "beforeChecklistIdが見つかりません。",
  "beforeItemId not found":
    "beforeItemIdが見つかりません。",
  "billing is only available in hosted mode":
    "請求はホスト型モードでのみ利用できます。",
  "board group not found":
    "ボードグループが見つかりません。",
  "board is not a standalone board":
    "このボードは独立ボードではありません。",
  "board linking is disabled for one or more participating workspaces":
    "参加しているワークスペースの1つ以上でボードのリンクが無効になっています。",
  "board membership not found":
    "ボードのメンバーシップが見つかりません。",
  "board mirror not found":
    "ボードのミラーが見つかりません。",
  "board not found":
    "ボードが見つかりません。",
  "board not in same workspace":
    "ボードが同じワークスペースにありません。",
  "board ordering anchor not found":
    "ボードの並び順アンカーが見つかりません。",
  "boardId is required":
    "boardIdは必須です。",
  "callback verification failed":
    "コールバックの検証に失敗しました。",
  "cannot change an inherited board admin role":
    "継承されたボード管理者のロールは変更できません。",
  "cannot change your own role":
    "自分のロールは変更できません。",
  "cannot demote the last owner":
    "最後のオーナーを降格することはできません。",
  "cannot react to your own attachment":
    "自分の添付ファイルにはリアクションできません。",
  "cannot react to your own comment":
    "自分のコメントにはリアクションできません。",
  "cannot remove an inherited board admin":
    "継承されたボード管理者は削除できません。",
  "cannot remove or downgrade the last workspace admin":
    "ワークスペースの最後の管理者を削除または降格することはできません。",
  "cannot remove yourself":
    "自分自身を削除することはできません。",
  "cannot reparent into descendant":
    "項目を自分の子孫の中に移動することはできません。",
  "cannot reparent into self":
    "項目を自分自身の中に移動することはできません。",
  "card is already in this queue":
    "カードはすでにこのキューにあります。",
  "card is completed or archived":
    "カードは完了済みまたはアーカイブ済みです。",
  "card is not assigned to that user":
    "カードはそのユーザーに割り当てられていません。",
  "card is not assigned to the Global Work user":
    "カードはGlobal Workユーザーに割り当てられていません。",
  "card key prefix is already reserved":
    "このカードキーのプレフィックスはすでに予約されています。",
  "card key prefix must match ^[A-Z][A-Z0-9]{1,9}$":
    "カードキーのプレフィックスは^[A-Z][A-Z0-9]{1,9}$に一致する必要があります。",
  "card must be assigned to the Global Work user":
    "カードはGlobal Workユーザーに割り当てる必要があります。",
  "card not found":
    "カードが見つかりません。",
  "cardLimit must be between 1 and 100":
    "cardLimitは1～100の範囲で指定してください。",
  "cardOffset must be a non-negative integer":
    "cardOffsetは0以上の整数で指定してください。",
  "chat destination not found":
    "チャットの送信先が見つかりません。",
  "checklist item not found":
    "チェックリスト項目が見つかりません。",
  "checklist not found":
    "チェックリストが見つかりません。",
  "choose a day/month order for ambiguous dates":
    "あいまいな日付の日と月の順序を選択してください。",
  "choose a priority custom field":
    "優先度のカスタムフィールドを選択してください。",
  "client authentication required":
    "クライアント認証が必要です。",
  "client cannot use this authorization request":
    "クライアントはこの認可リクエストを使用できません。",
  "client is not a service connection":
    "クライアントはサービス接続ではありません。",
  "client not found":
    "クライアントが見つかりません。",
  "client token was already used for another card create":
    "このクライアントトークンはすでに別のカード作成で使用されています。",
  "code, redirect_uri, and code_verifier are required":
    "code、redirect_uri、code_verifierは必須です。",
  "configure a webhook URL before rotating its secret":
    "シークレットをローテーションする前にWebhook URLを設定してください。",
  "could not add workspace member":
    "ワークスペースメンバーを追加できませんでした。",
  "could not create board":
    "ボードを作成できませんでした。",
  "could not generate an available card key prefix":
    "利用可能なカードキーのプレフィックスを生成できませんでした。",
  "could not resolve work-history range":
    "作業履歴の期間を特定できませんでした。",
  "cursor does not belong to card comments":
    "カーソルはカードのコメントのものではありません。",
  "custom field mapping target not found":
    "カスタムフィールドのマッピング先が見つかりません。",
  "custom field names must be unique within a workspace":
    "カスタムフィールド名はワークスペース内で一意である必要があります。",
  "custom field not found":
    "カスタムフィールドが見つかりません。",
  "custom field trigger field is invalid":
    "トリガーのカスタムフィールドが無効です。",
  "custom field trigger user is not a workspace member":
    "カスタムフィールドトリガーのユーザーはワークスペースのメンバーではありません。",
  "custom field trigger value does not match field type":
    "カスタムフィールドトリガーの値がフィールドの種類と一致しません。",
  "delivery not found":
    "配信が見つかりません。",
  "dependencies are disabled for this workspace":
    "このワークスペースでは依存関係が無効になっています。",
  "destination credentials are required":
    "送信先の認証情報が必要です。",
  "email already registered":
    "このメールアドレスはすでに登録されています。",
  "email not found":
    "メールアドレスが見つかりません。",
  "enable the destination before sending a test":
    "テストを送信する前に送信先を有効にしてください。",
  "enabled automations require at least one action":
    "有効なオートメーションには少なくとも1つのアクションが必要です。",
  "enrollment incomplete":
    "登録が完了していません。",
  "enter a demo password because no existing demo password is available":
    "既存のデモ用パスワードがないため、デモ用パスワードを入力してください。",
  "entityId is not a card in this workspace":
    "entityIdはこのワークスペースのカードではありません。",
  "entityId is not a checklist in this workspace":
    "entityIdはこのワークスペースのチェックリストではありません。",
  "entityId is not a checklist item in this workspace":
    "entityIdはこのワークスペースのチェックリスト項目ではありません。",
  "entityId is not a comment in this workspace":
    "entityIdはこのワークスペースのコメントではありません。",
  "entityId is not an attachment in this workspace":
    "entityIdはこのワークスペースの添付ファイルではありません。",
  "expected a single option":
    "オプションは1つだけ指定してください。",
  "expected a single user":
    "ユーザーは1人だけ指定してください。",
  "external link not found":
    "外部リンクが見つかりません。",
  "failed to persist web push configuration":
    "Webプッシュの設定を保存できませんでした。",
  "file too large":
    "ファイルが大きすぎます。",
  "following and reminders need a personal API key or OAuth connection":
    "ウォッチとリマインダーには個人用APIキーまたはOAuth接続が必要です。",
  "import columns cannot be changed now":
    "インポートの列は現在変更できません。",
  "import is not ready to commit":
    "インポートはまだ確定できる状態ではありません。",
  "import not found":
    "インポートが見つかりません。",
  "imports cannot create a second board in a standalone board":
    "独立ボード内に2つ目のボードをインポートで作成することはできません。",
  "inline media from integrations must be uploaded to Kanera before embedding":
    "連携機能からのインラインメディアは、埋め込む前にKaneraにアップロードする必要があります。",
  "invalid Discord webhook url":
    "DiscordのWebhook URLが無効です。",
  "invalid MCP service credential":
    "MCPサービスの認証情報が無効です。",
  "invalid Slack incoming webhook url":
    "Slackの受信Webhook URLが無効です。",
  "invalid Telegram credentials":
    "Telegramの認証情報が無効です。",
  "invalid activity cursor":
    "アクティビティのカーソルが無効です。",
  "invalid card feed cursor":
    "カードフィードのカーソルが無効です。",
  "invalid client credentials":
    "クライアントの認証情報が無効です。",
  "invalid commentId":
    "commentIdが無効です。",
  "invalid completed cards cursor":
    "完了したカードのカーソルが無効です。",
  "invalid credentials":
    "認証情報が無効です。",
  "invalid current password":
    "現在のパスワードが正しくありません。",
  "invalid invite":
    "招待が無効です。",
  "invalid notification destination url":
    "通知先のURLが無効です。",
  "invalid or expired MCP access token":
    "MCPアクセストークンが無効か、有効期限が切れています。",
  "invalid or expired challenge":
    "チャレンジが無効か、有効期限が切れています。",
  "invalid or expired invitation":
    "招待が無効か、有効期限が切れています。",
  "invalid or expired verification code":
    "確認コードが無効か、有効期限が切れています。",
  "invalid password":
    "パスワードが正しくありません。",
  "invalid refresh token":
    "リフレッシュトークンが無効です。",
  "invalid reset token":
    "リセットトークンが無効です。",
  "invalid source":
    "ソースが無効です。",
  "invalid status (expected pending|dispatched)":
    "ステータスが無効です（pending|dispatchedを指定してください）。",
  "invalid status":
    "ステータスが無効です。",
  "invalid verification code":
    "確認コードが無効です。",
  "invalid webhook url":
    "Webhook URLが無効です。",
  "invalid work cursor":
    "作業のカーソルが無効です。",
  "invalid work-done day range":
    "完了した作業の日付範囲が無効です。",
  "invalid work-history cursor":
    "作業履歴のカーソルが無効です。",
  "invitation already accepted":
    "招待はすでに承諾されています。",
  "items in nested checklists do not support descriptions":
    "ネストされたチェックリストの項目には説明を追加できません。",
  "label mapping target not found in workspace":
    "ラベルのマッピング先がワークスペースに見つかりません。",
  "label not in workspace":
    "ラベルがワークスペースにありません。",
  "limit must be a positive integer":
    "limitは正の整数で指定してください。",
  "list mapping target not found in workspace":
    "リストのマッピング先がワークスペースに見つかりません。",
  "list not in workspace":
    "リストがワークスペースにありません。",
  "listId must identify a list in the monitored workspace":
    "listIdには監視対象ワークスペースのリストを指定してください。",
  "member mapping target not found in workspace":
    "メンバーのマッピング先がワークスペースに見つかりません。",
  "nested checklist items do not support assignees or due dates":
    "ネストされたチェックリスト項目には担当者と期限を設定できません。",
  "nested checklist items do not support descriptions":
    "ネストされたチェックリスト項目には説明を追加できません。",
  "nested checklist items support only text and completion":
    "ネストされたチェックリスト項目はテキストと完了状態のみに対応しています。",
  "no active organisation membership":
    "有効な組織のメンバーシップがありません。",
  "no file uploaded":
    "ファイルがアップロードされていません。",
  "note has changed since editing started":
    "編集の開始後にノートが変更されました。",
  "note is being edited by another user":
    "ノートは別のユーザーが編集中です。",
  "note tree contains a cycle":
    "ノートのツリーに循環があります。",
  "notes are disabled for this workspace":
    "このワークスペースではノートが無効になっています。",
  "notes can only be nested 3 levels deep":
    "ノートは3階層までしかネストできません。",
  "notification destination host is not allowed":
    "通知先のホストは許可されていません。",
  "notification destination host resolves to a blocked address":
    "通知先のホストがブロックされたアドレスに解決されます。",
  "notification destination url must not contain a fragment":
    "通知先のURLにフラグメントを含めることはできません。",
  "notification destination url must not contain credentials":
    "通知先のURLに認証情報を含めることはできません。",
  "notification server url must not contain a query string":
    "通知サーバーのURLにクエリ文字列を含めることはできません。",
  "ntfy requires a server URL and topic":
    "ntfyにはサーバーURLとトピックが必要です。",
  "one or more action checklist template ids are invalid":
    "アクションのチェックリストテンプレートIDに無効なものがあります。",
  "one or more action label ids are invalid":
    "アクションのラベルIDに無効なものがあります。",
  "one or more action list ids are invalid":
    "アクションのリストIDに無効なものがあります。",
  "one or more action user ids are not assignable workspace members":
    "アクションのユーザーIDに、割り当て可能なワークスペースメンバーではないものがあります。",
  "one or more action webhook endpoint ids are invalid":
    "アクションのWebhookエンドポイントIDに無効なものがあります。",
  "one or more card ids are not in this board":
    "このボードにないカードIDが含まれています。",
  "one or more cards were not found on this board":
    "このボードで見つからないカードがあります。",
  "one or more checklist item ids do not match the supplied board, card, or checklist":
    "指定されたボード、カード、またはチェックリストと一致しないチェックリスト項目IDがあります。",
  "one or more checklists were not found on their cards":
    "カード上で見つからないチェックリストがあります。",
  "one or more label ids are invalid":
    "無効なラベルIDがあります。",
  "one or more set custom field ids are invalid":
    "設定するカスタムフィールドIDに無効なものがあります。",
  "one or more source lists are not in the source workspace":
    "元のワークスペースにない元リストがあります。",
  "one or more target lists are not in the target workspace":
    "先のワークスペースにない先リストがあります。",
  "one or more trigger user ids are not assignable workspace members":
    "トリガーのユーザーIDに、割り当て可能なワークスペースメンバーではないものがあります。",
  "one or more user ids are not assignable members":
    "割り当て可能なメンバーではないユーザーIDがあります。",
  "only an owner can change owner roles":
    "オーナーのロールを変更できるのはオーナーのみです。",
  "only an owner can remove an owner":
    "オーナーを削除できるのはオーナーのみです。",
  "only failed deliveries can be retried":
    "再試行できるのは失敗した配信のみです。",
  "only failed emails can be retried":
    "再試行できるのは失敗したメールのみです。",
  "only failed push notifications can be retried":
    "再試行できるのは失敗したプッシュ通知のみです。",
  "only failed webhook deliveries can be retried":
    "再試行できるのは失敗したWebhook配信のみです。",
  "only pending emails can be cancelled":
    "キャンセルできるのは保留中のメールのみです。",
  "only pending outbox events can be cancelled":
    "キャンセルできるのは保留中のアウトボックスイベントのみです。",
  "only pending outbox events can be retried":
    "再試行できるのは保留中のアウトボックスイベントのみです。",
  "only pending push notifications can be cancelled":
    "キャンセルできるのは保留中のプッシュ通知のみです。",
  "only pending webhook deliveries can be cancelled":
    "キャンセルできるのは保留中のWebhook配信のみです。",
  "only user sessions can create an organisation":
    "組織を作成できるのはユーザーセッションのみです。",
  "only user sessions can delete an organisation":
    "組織を削除できるのはユーザーセッションのみです。",
  "option not found":
    "オプションが見つかりません。",
  "options are only valid for select fields":
    "オプションは選択フィールドでのみ有効です。",
  "organisation is unavailable for billing":
    "この組織は請求に利用できません。",
  "organisation membership is not active":
    "組織のメンバーシップが有効ではありません。",
  "organisation membership not found":
    "組織のメンバーシップが見つかりません。",
  "organisation name does not match":
    "組織名が一致しません。",
  "organisation not found":
    "組織が見つかりません。",
  "organisation owners and admins already inherit standalone board access":
    "組織のオーナーと管理者は、すでに独立ボードへのアクセス権を継承しています。",
  "organisation owners and admins are always workspace admins":
    "組織のオーナーと管理者は常にワークスペースの管理者です。",
  "organisation owners and admins cannot be removed from a workspace":
    "組織のオーナーと管理者はワークスペースから削除できません。",
  "outbox event not found":
    "アウトボックスイベントが見つかりません。",
  "paid plans require trialing, active, or past_due billing status":
    "有料プランには、trialing、active、past_dueのいずれかの請求ステータスが必要です。",
  "parent note in different scope":
    "親ノートが別のスコープにあります。",
  "parent note not found":
    "親ノートが見つかりません。",
  "parentItemId must identify a top-level item on this card":
    "parentItemIdにはこのカードの最上位の項目を指定してください。",
  "pending invitation not found":
    "保留中の招待が見つかりません。",
  "plan changes are only available in hosted mode":
    "プランの変更はホスト型モードでのみ利用できます。",
  "priority anchor is not visible":
    "優先事項のアンカーが表示されていません。",
  "priority field must be an active select or text field in this workspace":
    "優先度フィールドは、このワークスペースの有効な選択フィールドまたはテキストフィールドである必要があります。",
  "provide ids to add or remove":
    "追加または削除するIDを指定してください。",
  "public board card reads require listId and cardLimit; use includeCards=false for board metadata":
    "公開ボードのカードを読み取るにはlistIdとcardLimitが必要です。ボードのメタデータにはincludeCards=falseを使用してください。",
  "push messaging is managed by the hosted deployment":
    "プッシュメッセージはホスト型デプロイで管理されています。",
  "push notification not found":
    "プッシュ通知が見つかりません。",
  "rate limit exceeded":
    "リクエストの上限を超えました。",
  "redirect URIs must use HTTPS, except localhost callbacks":
    "リダイレクトURIには、localhostのコールバックを除きHTTPSを使用してください。",
  "redirect_uri is not registered":
    "redirect_uriが登録されていません。",
  "refresh token client mismatch":
    "リフレッシュトークンのクライアントが一致しません。",
  "refresh token reuse or expiry detected":
    "リフレッシュトークンの再利用または期限切れが検出されました。",
  "refresh_token is not allowed for this client":
    "このクライアントではrefresh_tokenは許可されていません。",
  "refresh_token is required":
    "refresh_tokenは必須です。",
  "remindAt must be in the future":
    "remindAtには未来の日時を指定してください。",
  "requested scope exceeds the service connection maximum":
    "要求されたスコープがサービス接続の上限を超えています。",
  "resource is required":
    "resourceは必須です。",
  "scratchpad page has changed since it was read":
    "読み込み後にスクラッチパッドのページが変更されました。",
  "secretAccessKey required":
    "secretAccessKeyは必須です。",
  "security challenge failed":
    "セキュリティチャレンジに失敗しました。",
  "security challenge required":
    "セキュリティチャレンジが必要です。",
  "set custom field copy source is invalid":
    "設定するカスタムフィールドのコピー元が無効です。",
  "set custom field value does not match field type":
    "設定するカスタムフィールドの値がフィールドの種類と一致しません。",
  "share target must be an active user in your organisation":
    "共有先は組織内の有効なユーザーである必要があります。",
  "since must be a cursor returned by a previous call":
    "sinceには前回の呼び出しで返されたカーソルを指定してください。",
  "smtp is configured by environment variables":
    "SMTPは環境変数で設定されています。",
  "smtp is configured by the hosted deployment":
    "SMTPはホスト型デプロイで設定されています。",
  "smtp password required":
    "SMTPのパスワードは必須です。",
  "smtpConfig required":
    "smtpConfigは必須です。",
  "source lists must be unique":
    "元リストは重複できません。",
  "standalone board configuration must contain exactly one board":
    "独立ボードの構成にはボードを1つだけ含める必要があります。",
  "standalone board import target not found":
    "独立ボードのインポート先が見つかりません。",
  "standalone boards cannot contain another board":
    "独立ボードに別のボードを含めることはできません。",
  "start dates and the timeline are disabled for this workspace":
    "このワークスペースでは開始日とタイムラインが無効になっています。",
  "storage is configured by environment variables":
    "ストレージは環境変数で設定されています。",
  "storage is configured by the hosted deployment":
    "ストレージはホスト型デプロイで設定されています。",
  "storageConfig required":
    "storageConfigは必須です。",
  "subscription limit reached":
    "サブスクリプションの上限に達しました。",
  "subscription not found":
    "サブスクリプションが見つかりません。",
  "superadmin required":
    "スーパー管理者の権限が必要です。",
  "support session not found":
    "サポートセッションが見つかりません。",
  "switch organisation to access this resource":
    "このリソースにアクセスするには組織を切り替えてください。",
  "target board must be in the same workspace":
    "移動先のボードは同じワークスペースにある必要があります。",
  "target board must differ from current board":
    "移動先のボードは現在のボードとは別のボードにしてください。",
  "target checklist must have the same parent item":
    "移動先のチェックリストは同じ親項目を持つ必要があります。",
  "target checklist not on this card":
    "移動先のチェックリストはこのカードにありません。",
  "target is not a removable board guest":
    "対象は削除可能なボードゲストではありません。",
  "target list not in board workspace":
    "移動先のリストがボードのワークスペースにありません。",
  "target list not in same workspace":
    "移動先のリストが同じワークスペースにありません。",
  "target list not in workspace":
    "移動先のリストがワークスペースにありません。",
  "target list required":
    "移動先のリストは必須です。",
  "target org not found or has no active owner to act as":
    "対象の組織が見つからないか、代理で操作できる有効なオーナーがいません。",
  "target user not found":
    "対象のユーザーが見つかりません。",
  "targetListId is required for cross-workspace mirrors":
    "ワークスペースをまたぐミラーにはtargetListIdが必要です。",
  "targetListId must differ from source list":
    "targetListIdは元のリストとは別のものにしてください。",
  "telegram requires a bot token and chat id":
    "TelegramにはボットトークンとチャットIDが必要です。",
  "that is already your email address":
    "それはすでにあなたのメールアドレスです。",
  "the credential that created this upload link is no longer valid":
    "このアップロードリンクを作成した認証情報は無効になっています。",
  "the final active superadmin cannot be disabled":
    "最後の有効なスーパー管理者は無効にできません。",
  "the mirror provider namespace is reserved":
    "ミラープロバイダーの名前空間は予約されています。",
  "the notification inbox needs a personal API key or OAuth connection":
    "通知の受信箱には個人用APIキーまたはOAuth接続が必要です。",
  "the owner already has access":
    "オーナーはすでにアクセスできます。",
  "the scratchpad needs a personal API key or OAuth connection":
    "スクラッチパッドには個人用APIキーまたはOAuth接続が必要です。",
  "this GitHub installation is not accessible to the authorizing GitHub user":
    "このGitHubインストールには、認可するGitHubユーザーがアクセスできません。",
  "this board mirror already exists":
    "このボードのミラーはすでに存在します。",
  "this guest must subscribe to an assigned card":
    "このゲストは割り当てられたカードをウォッチする必要があります。",
  "this invitation was sent to a different email address":
    "この招待は別のメールアドレスに送信されました。",
  "time in progress is disabled for this workspace":
    "このワークスペースでは進行中の時間が無効になっています。",
  "too many attempts; request a new code":
    "試行回数が多すぎます。新しいコードをリクエストしてください。",
  "triggerCustomFieldId and triggerCustomFieldValue are required":
    "triggerCustomFieldIdとtriggerCustomFieldValueは必須です。",
  "triggerDaysBefore is required":
    "triggerDaysBeforeは必須です。",
  "in-progress limit field must be a number field":
    "進行中の時間の上限フィールドは数値フィールドである必要があります。",
  "triggerCustomFieldId is required":
    "triggerCustomFieldIdは必須です。",
  "triggerThresholdAmount is required":
    "triggerThresholdAmountは必須です。",
  "triggerThresholdUnit is required":
    "triggerThresholdUnitは必須です。",
  "triggerLabelId is required":
    "triggerLabelIdは必須です。",
  "triggerListId is required":
    "triggerListIdは必須です。",
  "triggerUserIds is required":
    "triggerUserIdsは必須です。",
  "unknown event":
    "不明なイベントです。",
  "unknown option for custom field trigger":
    "カスタムフィールドトリガーのオプションが不明です。",
  "unknown option for set custom field action":
    "カスタムフィールド設定アクションのオプションが不明です。",
  "unknown option for this field":
    "このフィールドのオプションが不明です。",
  "unknown or revoked OAuth client":
    "OAuthクライアントが不明か、取り消されています。",
  "unsubscribe link is invalid":
    "配信停止リンクが無効です。",
  "unsupported OAuth resource":
    "サポートされていないOAuthリソースです。",
  "unsupported OAuth scope":
    "サポートされていないOAuthスコープです。",
  "unsupported delivery mode":
    "サポートされていない配信モードです。",
  "unsupported file type":
    "サポートされていないファイル形式です。",
  "unsupported file type; pass a supported mimeType or a file name with a supported extension":
    "サポートされていないファイル形式です。サポートされているmimeTypeか、サポートされている拡張子のファイル名を指定してください。",
  "unsupported grant_type":
    "サポートされていないgrant_typeです。",
  "upload a CSV file":
    "CSVファイルをアップロードしてください。",
  "upload a Kanera board JSON export":
    "KaneraボードのJSONエクスポートをアップロードしてください。",
  "upload a Trello JSON export":
    "TrelloのJSONエクスポートをアップロードしてください。",
  "upload body is empty":
    "アップロードの本文が空です。",
  "upload link is invalid, expired, or already used; create a new one":
    "アップロードリンクが無効か、有効期限が切れているか、すでに使用されています。新しいリンクを作成してください。",
  "use /billing/checkout to start a Stripe checkout session":
    "Stripeの決済セッションを開始するには/billing/checkoutを使用してください。",
  "use /billing/portal to manage or cancel a Stripe subscription":
    "Stripeのサブスクリプションを管理またはキャンセルするには/billing/portalを使用してください。",
  "use add/remove for multi-value fields":
    "複数値フィールドにはadd/removeを使用してください。",
  "use the leave organisation action to remove yourself":
    "自分自身を削除するには、組織から退出する操作を使用してください。",
  "user is already a board member":
    "ユーザーはすでにボードのメンバーです。",
  "user is already a workspace member":
    "ユーザーはすでにワークスペースのメンバーです。",
  "user is not a workspace member":
    "ユーザーはワークスペースのメンバーではありません。",
  "user is not visible in the selected work scope":
    "ユーザーは選択された作業範囲に表示されません。",
  "user not found":
    "ユーザーが見つかりません。",
  "users already associated with this organisation cannot accept board guest invites":
    "すでにこの組織に関連付けられているユーザーは、ボードのゲスト招待を承諾できません。",
  "users already in this organisation cannot accept board guest invites":
    "すでにこの組織に所属しているユーザーは、ボードのゲスト招待を承諾できません。",
  "variant must be original, cover, or thumbnail":
    "variantにはoriginal、cover、thumbnailのいずれかを指定してください。",
  "verification code required":
    "確認コードは必須です。",
  "webhook not found":
    "Webhookが見つかりません。",
  "webhook requires a URL and signing secret":
    "WebhookにはURLと署名シークレットが必要です。",
  "webhook url host is not allowed":
    "Webhook URLのホストは許可されていません。",
  "webhook url host resolves to a blocked address":
    "Webhook URLのホストがブロックされたアドレスに解決されます。",
  "webhook url must use http(s)":
    "Webhook URLにはhttp(s)を使用してください。",
  "webhook url must use https":
    "Webhook URLにはhttpsを使用してください。",
  "work view not found":
    "作業ビューが見つかりません。",
  "work-done day cannot be in the future":
    "完了した作業の日付に未来の日は指定できません。",
  "work-history cursor does not match this query":
    "作業履歴のカーソルがこのクエリと一致しません。",
  "workspace name does not match":
    "ワークスペース名が一致しません。",
  "workspace not found":
    "ワークスペースが見つかりません。",
  "workspace not in your organisation":
    "ワークスペースがご利用の組織にありません。",
  "write-capable credential required":
    "書き込み可能な認証情報が必要です。",
  "you are already a member of this organisation":
    "すでにこの組織のメンバーです。",
  "you cannot disable your own account":
    "自分のアカウントは無効にできません。",
  "you cannot reset your own MFA":
    "自分のMFAはリセットできません。",
  "your membership of this organisation is suspended":
    "この組織でのメンバーシップは停止されています。",
  "validation failed":
    "検証に失敗しました。",
  "internal error":
    "内部エラーが発生しました。",
  "forbidden":
    "この操作を行う権限がありません。",
  "not found":
    "見つかりません。",
  "conflict":
    "競合が発生しました。",
  "bad request":
    "リクエストが正しくありません。",
  "unauthorized":
    "認証されていません。",
  "web push is not configured":
    "Webプッシュが設定されていません。",
  "push messages are disabled for this organisation":
    "この組織ではプッシュメッセージが無効になっています。",
  "provide dueDateLocalDate when setting dueDateSlot":
    "dueDateSlotを設定するときはdueDateLocalDateを指定してください。",
  "cannot leave as the last owner":
    "最後のオーナーは退出できません。",
  "cannot remove the last owner":
    "最後のオーナーは削除できません。",
  "notification destination url must use http(s)":
    "通知先のURLにはhttp(s)を使用してください。",
  "notification destination url must use https":
    "通知先のURLにはhttpsを使用してください。",
  "invalid authorization code":
    "認可コードが無効です。",
  "authorization grant is revoked":
    "認可は取り消されています。",
  "Request body is too large":
    "リクエスト本文が大きすぎます。",
  "Unsupported Media Type":
    "サポートされていないメディアタイプです。",
  "Request body size did not match Content-Length":
    "リクエスト本文のサイズがContent-Lengthと一致しません。",
  "Body cannot be empty when content-type is set to 'application/json'":
    "content-typeが'application/json'の場合、本文を空にすることはできません。",
  "Body is not valid JSON but content-type is set to 'application/json'":
    "content-typeが'application/json'ですが、本文が有効なJSONではありません。",
  "Your plan's boards limit has been reached. Upgrade to add more.":
    "ご利用のプランのボード数の上限に達しました。追加するにはアップグレードしてください。",
  "Your plan's members limit has been reached. Upgrade to add more.":
    "ご利用のプランのメンバー数の上限に達しました。追加するにはアップグレードしてください。",
  "Your plan's enabled automations limit has been reached. Upgrade to add more.":
    "ご利用のプランの有効なオートメーション数の上限に達しました。追加するにはアップグレードしてください。",
  "This organisation is on the Free plan, which allows your AI agents and API keys {limit} requests per second on its boards, and the request queue is full. Retry shortly; Kanera Pro raises these limits.":
    "この組織はFreeプランです。このプランでは、AIエージェントとAPIキーによるボードへのリクエストは毎秒{limit}件までで、リクエストキューも満杯です。しばらくしてからもう一度お試しください。Kanera Proではこの上限が引き上げられます。",
  "This organisation is on the Free plan, which allows your AI agents and API keys {limit} requests per minute on its boards. Retry shortly; Kanera Pro raises these limits.":
    "この組織はFreeプランです。このプランでは、AIエージェントとAPIキーによるボードへのリクエストは毎分{limit}件までです。しばらくしてからもう一度お試しください。Kanera Proではこの上限が引き上げられます。",
  "{field} not found":
    "{field}が見つかりません。",
  "{type} anchor not found":
    "{type}のアンカーが見つかりません。",
  "{provider} requires a webhook url":
    "{provider}にはWebhook URLが必要です。",
  "CSV column {column} does not exist":
    "CSVの列{column}は存在しません。",
  "CSV exceeds the {max} column limit":
    "CSVが列数の上限（{max}列）を超えています。",
  "CSV exceeds the {max} row limit":
    "CSVが行数の上限（{max}行）を超えています。",
  "File is too large. The maximum file size is {size}.":
    "ファイルが大きすぎます。ファイルサイズの上限は{size}です。",
  "Workspaces can have up to {max} automations. Contact support if you need more.":
    "ワークスペースに作成できるオートメーションは{max}件までです。さらに必要な場合はサポートにお問い合わせください。",
  "Your organisation has used its {quota} storage allowance. Upgrade the plan or remove files to upload more.":
    "ご利用の組織はストレージ容量（{quota}）を使い切りました。さらにアップロードするには、プランをアップグレードするかファイルを削除してください。",
  "a priority queue holds at most {max} cards":
    "優先事項のキューに入れられるカードは{max}件までです。",
  "a scratchpad holds at most {max} pages":
    "スクラッチパッドに作成できるページは{max}件までです。",
  "a scratchpad holds at most {max} pages; capture to an existing page title":
    "スクラッチパッドに作成できるページは{max}件までです。既存のページタイトルにキャプチャしてください。",
  "automation action checklist template not found: {name}":
    "オートメーションアクションのチェックリストテンプレートが見つかりません：{name}",
  "automation action custom field not found: {name}":
    "オートメーションアクションのカスタムフィールドが見つかりません：{name}",
  "automation action custom field option not found: {name}":
    "オートメーションアクションのカスタムフィールドのオプションが見つかりません：{name}",
  "automation action label not found: {name}":
    "オートメーションアクションのラベルが見つかりません：{name}",
  "automation action list not found: {name}":
    "オートメーションアクションのリストが見つかりません：{name}",
  "automation trigger label not found: {name}":
    "オートメーショントリガーのラベルが見つかりません：{name}",
  "automation trigger list not found: {name}":
    "オートメーショントリガーのリストが見つかりません：{name}",
  "starter card checklist template not found: {name}":
    "初期カードのチェックリストテンプレートが見つかりません：{name}",
  "starter card label not found: {name}":
    "初期カードのラベルが見つかりません：{name}",
  "starter card list not found: {name}":
    "初期カードのリストが見つかりません：{name}",
  "bulk delete only removes comments you authored; not authored by you: {ids}":
    "一括削除で削除できるのは自分が投稿したコメントのみです。自分以外が投稿したコメント：{ids}",
  "cannot delete the last owner of {orgName}":
    "{orgName}の最後のオーナーは削除できません。",
  "cards[{index}]: {message}":
    "cards[{index}]: {message}",
  "comments not found on this board: {ids}":
    "このボードで見つからないコメント：{ids}",
  "could not parse CSV: {reason}":
    "CSVを解析できませんでした：{reason}",
  "could not parse Kanera JSON: {reason}":
    "KaneraのJSONを解析できませんでした：{reason}",
  "could not parse Trello JSON: {reason}":
    "TrelloのJSONを解析できませんでした：{reason}",
  "expected {type} value":
    "{type}の値が必要です。",
  "invalid {provider} credentials":
    "{provider}の認証情報が無効です。",
  "remindAt must be within {days} days":
    "remindAtは{days}日以内で指定してください。",
  "this attachment has no {variant} image":
    "この添付ファイルには{variant}画像がありません。",
  "work-done history is limited to the last {days} days":
    "完了した作業の履歴は過去{days}日分に限られます。",
  "a card cannot be related to itself": "カードを自分自身に関連付けることはできません。",
  "a completed card cannot block another card": "完了したカードは他のカードをブロックできません。",
  "cards must be in the same workspace to be related": "関連付けるカードは同じワークスペースにある必要があります。",
  "relation not found": "関係が見つかりません。",
  "this relation would create a blocking cycle": "この関係はブロックの循環を作ります。",
};
