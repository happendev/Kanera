import type { ErrorCatalog } from "./source.js";

// pt-BR translations of the API error catalog. Terms and voice follow apps/web/src/locale/GLOSSARY.md.
export const ptBR: ErrorCatalog = {
  "AI agent access is turned off for this organisation":
    "O acesso de agentes de IA está desativado para esta organização.",
  "Additional notification destinations are not available on your plan. Upgrade to configure ntfy, Gotify, or a personal webhook.":
    "Destinos de notificação adicionais não estão disponíveis no seu plano. Faça upgrade para configurar ntfy, Gotify ou um webhook pessoal.",
  "All purchased seats are in use. Buy more seats to add this person.":
    "Todas as licenças compradas estão em uso. Compre mais licenças para adicionar esta pessoa.",
  "An account already exists for this email. Sign in to accept the invite.":
    "Já existe uma conta com este e-mail. Entre para aceitar o convite.",
  "Billing cancellation could not be confirmed, so the organisation was not deleted. Please try again.":
    "Não foi possível confirmar o cancelamento da cobrança, então a organização não foi excluída. Tente novamente.",
  "Board syncing requires Pro in both participating organisations.":
    "A sincronização de quadros exige o Pro nas duas organizações participantes.",
  "CSV did not contain any rows":
    "O CSV não continha nenhuma linha.",
  "Device code is invalid or expired":
    "O código do dispositivo é inválido ou expirou.",
  "GitHub App is already configured through the deployment environment":
    "O GitHub App já está configurado pelo ambiente de implantação.",
  "GitHub App is configured through the deployment environment":
    "O GitHub App é configurado pelo ambiente de implantação.",
  "GitHub App is not configured":
    "O GitHub App não está configurado.",
  "GitHub App manifest could not be completed":
    "Não foi possível concluir o manifesto do GitHub App.",
  "GitHub App not found":
    "GitHub App não encontrado.",
  "GitHub App setup is managed by the hosted deployment":
    "A configuração do GitHub App é gerenciada pela implantação hospedada.",
  "GitHub App user authorization is not configured for this deployment":
    "A autorização de usuário do GitHub App não está configurada nesta implantação.",
  "GitHub installation could not be verified":
    "Não foi possível verificar a instalação do GitHub.",
  "GitHub installation not found":
    "Instalação do GitHub não encontrada.",
  "GitHub manifest state did not match this organisation":
    "O estado do manifesto do GitHub não corresponde a esta organização.",
  "GitHub user authorization could not be verified":
    "Não foi possível verificar a autorização de usuário do GitHub.",
  "GitHub user authorization is required to connect an installation":
    "A autorização de usuário do GitHub é necessária para conectar uma instalação.",
  "Global Work layout anchors are not available through this API":
    "As âncoras de layout do Global Work não estão disponíveis por esta API.",
  "Gotify requires a server URL and app token":
    "O Gotify exige uma URL de servidor e um token de aplicativo.",
  "Guests are not available on your plan. Upgrade to invite guests.":
    "Convidados não estão disponíveis no seu plano. Faça upgrade para convidar convidados.",
  "Idempotency-Key must contain 1 to 255 visible ASCII characters":
    "Idempotency-Key deve conter de 1 a 255 caracteres ASCII visíveis.",
  "Idempotency-Key was already used for a different request":
    "Idempotency-Key já foi usada em outra solicitação.",
  "Invalid Stripe webhook signature":
    "A assinatura do webhook do Stripe é inválida.",
  "Invalid Stripe webhook":
    "O webhook do Stripe é inválido.",
  "Kanera export did not contain any lists":
    "A exportação do Kanera não continha nenhuma lista.",
  "MCP policy applies to hosted organisations only":
    "A política de MCP se aplica apenas a organizações hospedadas.",
  "MCP subscriptions require an API or OAuth credential":
    "As assinaturas de MCP exigem uma credencial de API ou OAuth.",
  "MFA enrollment is not required":
    "A configuração de MFA não é obrigatória.",
  "MFA is required by this organisation":
    "Esta organização exige MFA.",
  "MFA is required by your organisation":
    "Sua organização exige MFA.",
  "No Stripe customer exists for this organisation":
    "Não existe nenhum cliente do Stripe para esta organização.",
  "No Stripe subscription exists for this organisation":
    "Não existe nenhuma assinatura do Stripe para esta organização.",
  "No pending seat payment to confirm":
    "Não há nenhum pagamento de licenças pendente para confirmar.",
  "OAuth connection not found":
    "Conexão OAuth não encontrada.",
  "Organisation members are added directly to the board, not invited as guests.":
    "Membros da organização são adicionados diretamente ao quadro, não convidados como convidados.",
  "Seat capacity can only be changed for paid subscriptions":
    "A quantidade de licenças só pode ser alterada em assinaturas pagas.",
  "Signups are currently disabled.":
    "Os cadastros estão desativados no momento.",
  "Stripe did not return a checkout URL":
    "O Stripe não retornou uma URL de pagamento.",
  "Stripe is not configured":
    "O Stripe não está configurado.",
  "Stripe price is not configured":
    "O preço do Stripe não está configurado.",
  "Stripe webhook secret is not configured":
    "O segredo do webhook do Stripe não está configurado.",
  "The invited boards are no longer available.":
    "Os quadros para os quais você foi convidado não estão mais disponíveis.",
  "There is already a pending invite for this email and board.":
    "Já existe um convite pendente para este e-mail e este quadro.",
  "This board invitation is invalid or has expired.":
    "Este convite para o quadro é inválido ou expirou.",
  "This invitation was sent to a different email address. Sign up with the invited address.":
    "Este convite foi enviado para outro endereço de e-mail. Crie sua conta com o endereço convidado.",
  "This person already has access to this board.":
    "Esta pessoa já tem acesso a este quadro.",
  "Trello export did not contain any lists":
    "A exportação do Trello não continha nenhuma lista.",
  "Update your billing details before adding seats.":
    "Atualize seus dados de cobrança antes de adicionar licenças.",
  "We haven't received confirmation of your payment yet. Complete it and try again.":
    "Ainda não recebemos a confirmação do seu pagamento. Conclua o pagamento e tente novamente.",
  "Webhooks are not available on your plan. Upgrade to create webhooks.":
    "Webhooks não estão disponíveis no seu plano. Faça upgrade para criar webhooks.",
  "Workspace API keys and unattended AI agents are not available on your plan. Upgrade to create them, or use a personal API key or interactive agent connection.":
    "Chaves de API do espaço de trabalho e agentes de IA autônomos não estão disponíveis no seu plano. Faça upgrade para criá-los ou use uma chave de API pessoal ou uma conexão de agente interativa.",
  "You have more assigned seats than that — remove members or guests first.":
    "Você tem mais licenças atribuídas do que isso. Remova membros ou convidados primeiro.",
  "Your payment method needs attention before we can add seats. Update your payment method, then try again.":
    "Sua forma de pagamento precisa de atenção antes de adicionarmos licenças. Atualize sua forma de pagamento e tente novamente.",
  "a board cannot be both a mirror source and a mirror target":
    "Um quadro não pode ser ao mesmo tempo origem e destino de um espelho.",
  "a board cannot mirror itself":
    "Um quadro não pode espelhar a si mesmo.",
  "a checklist changed while preparing the batch; retry with fresh content":
    "Uma checklist mudou enquanto o lote era preparado. Tente novamente com o conteúdo atualizado.",
  "a checklist item changed while applying the batch; retry with fresh content":
    "Um item da checklist mudou enquanto o lote era aplicado. Tente novamente com o conteúdo atualizado.",
  "a comment changed while applying the batch; retry with a fresh comment list":
    "Um comentário mudou enquanto o lote era aplicado. Tente novamente com uma lista de comentários atualizada.",
  "a demo reset is already running":
    "Já existe uma redefinição da demonstração em andamento.",
  "accessKeyId required":
    "accessKeyId é obrigatório.",
  "account disabled":
    "A conta está desativada.",
  "activity cursor does not match this board":
    "O cursor de atividade não corresponde a este quadro.",
  "add/remove is only valid for multi-value select or user fields":
    "Adicionar ou remover só é válido para campos de seleção múltipla ou de usuário.",
  "administrator not found":
    "Administrador não encontrado.",
  "afterChecklistId not found":
    "afterChecklistId não encontrado.",
  "afterItemId not found":
    "afterItemId não encontrado.",
  "agent connection not found":
    "Conexão do agente não encontrada.",
  "agent run has already ended":
    "A execução do agente já terminou.",
  "agent run not found":
    "Execução do agente não encontrada.",
  "an administrator with this email already exists":
    "Já existe um administrador com este e-mail.",
  "an idempotent request with this key is already in progress":
    "Já existe uma solicitação idempotente com esta chave em andamento.",
  "anchor page not found":
    "Página de referência não encontrada.",
  "api key not found":
    "Chave de API não encontrada.",
  "archived cards are read-only":
    "Cartões arquivados são somente leitura.",
  "archived source lists cannot be mirrored":
    "Listas de origem arquivadas não podem ser espelhadas.",
  "archived target lists cannot be selected":
    "Listas de destino arquivadas não podem ser selecionadas.",
  "assignee is not an assignable member":
    "O responsável não é um membro que pode ser atribuído.",
  "attachment storage unavailable":
    "O armazenamento de anexos não está disponível.",
  "authorization_code is not allowed for this client":
    "authorization_code não é permitido para este cliente.",
  "beforeChecklistId not found":
    "beforeChecklistId não encontrado.",
  "beforeItemId not found":
    "beforeItemId não encontrado.",
  "billing is only available in hosted mode":
    "A cobrança só está disponível no modo hospedado.",
  "board group not found":
    "Grupo de quadros não encontrado.",
  "board is not a standalone board":
    "O quadro não é um quadro independente.",
  "board linking is disabled for one or more participating workspaces":
    "A vinculação de quadros está desativada em um ou mais espaços de trabalho participantes.",
  "board membership not found":
    "Associação ao quadro não encontrada.",
  "board mirror not found":
    "Espelho do quadro não encontrado.",
  "board not found":
    "Quadro não encontrado.",
  "board not in same workspace":
    "O quadro não está no mesmo espaço de trabalho.",
  "board ordering anchor not found":
    "Âncora de ordenação do quadro não encontrada.",
  "boardId is required":
    "boardId é obrigatório.",
  "callback verification failed":
    "Não foi possível verificar o callback.",
  "cannot change an inherited board admin role":
    "Não é possível alterar uma função de administrador do quadro herdada.",
  "cannot change your own role":
    "Você não pode alterar sua própria função.",
  "cannot demote the last owner":
    "Não é possível rebaixar o último proprietário.",
  "cannot react to your own attachment":
    "Você não pode reagir ao seu próprio anexo.",
  "cannot react to your own comment":
    "Você não pode reagir ao seu próprio comentário.",
  "cannot remove an inherited board admin":
    "Não é possível remover um administrador do quadro herdado.",
  "cannot remove or downgrade the last workspace admin":
    "Não é possível remover ou rebaixar o último administrador do espaço de trabalho.",
  "cannot remove yourself":
    "Você não pode remover a si mesmo.",
  "cannot reparent into descendant":
    "Não é possível mover um item para dentro de um de seus descendentes.",
  "cannot reparent into self":
    "Não é possível mover um item para dentro dele mesmo.",
  "card is already in this queue":
    "O cartão já está nesta fila.",
  "card is completed or archived":
    "O cartão está concluído ou arquivado.",
  "card is not assigned to that user":
    "O cartão não está atribuído a esse usuário.",
  "card is not assigned to the Global Work user":
    "O cartão não está atribuído ao usuário do Global Work.",
  "card key prefix is already reserved":
    "O prefixo da chave do cartão já está reservado.",
  "card key prefix must match ^[A-Z][A-Z0-9]{1,9}$":
    "O prefixo da chave do cartão deve corresponder a ^[A-Z][A-Z0-9]{1,9}$.",
  "card must be assigned to the Global Work user":
    "O cartão deve estar atribuído ao usuário do Global Work.",
  "card not found":
    "Cartão não encontrado.",
  "cardLimit must be between 1 and 100":
    "cardLimit deve estar entre 1 e 100.",
  "cardOffset must be a non-negative integer":
    "cardOffset deve ser um número inteiro não negativo.",
  "chat destination not found":
    "Destino de chat não encontrado.",
  "checklist item not found":
    "Item da checklist não encontrado.",
  "checklist not found":
    "Checklist não encontrada.",
  "choose a day/month order for ambiguous dates":
    "Escolha uma ordem de dia e mês para datas ambíguas.",
  "choose a priority custom field":
    "Escolha um campo personalizado de prioridade.",
  "client authentication required":
    "A autenticação do cliente é obrigatória.",
  "client cannot use this authorization request":
    "O cliente não pode usar esta solicitação de autorização.",
  "client is not a service connection":
    "O cliente não é uma conexão de serviço.",
  "client not found":
    "Cliente não encontrado.",
  "client token was already used for another card create":
    "O token do cliente já foi usado para criar outro cartão.",
  "code, redirect_uri, and code_verifier are required":
    "code, redirect_uri e code_verifier são obrigatórios.",
  "configure a webhook URL before rotating its secret":
    "Configure uma URL de webhook antes de trocar o segredo dele.",
  "could not add workspace member":
    "Não foi possível adicionar o membro ao espaço de trabalho.",
  "could not create board":
    "Não foi possível criar o quadro.",
  "could not generate an available card key prefix":
    "Não foi possível gerar um prefixo de chave de cartão disponível.",
  "could not resolve work-history range":
    "Não foi possível determinar o período do histórico de trabalho.",
  "cursor does not belong to card comments":
    "O cursor não pertence aos comentários do cartão.",
  "custom field mapping target not found":
    "Destino de mapeamento do campo personalizado não encontrado.",
  "custom field names must be unique within a workspace":
    "Os nomes dos campos personalizados devem ser únicos em um espaço de trabalho.",
  "custom field not found":
    "Campo personalizado não encontrado.",
  "custom field trigger field is invalid":
    "O campo personalizado do gatilho é inválido.",
  "custom field trigger user is not a workspace member":
    "O usuário do gatilho do campo personalizado não é membro do espaço de trabalho.",
  "custom field trigger value does not match field type":
    "O valor do gatilho do campo personalizado não corresponde ao tipo do campo.",
  "delivery not found":
    "Entrega não encontrada.",
  "destination credentials are required":
    "As credenciais do destino são obrigatórias.",
  "email already registered":
    "Este e-mail já está cadastrado.",
  "email not found":
    "E-mail não encontrado.",
  "enable the destination before sending a test":
    "Ative o destino antes de enviar um teste.",
  "enabled automations require at least one action":
    "Automações ativas precisam de pelo menos uma ação.",
  "enrollment incomplete":
    "A configuração não foi concluída.",
  "enter a demo password because no existing demo password is available":
    "Informe uma senha de demonstração, pois não há nenhuma disponível.",
  "entityId is not a card in this workspace":
    "entityId não é um cartão deste espaço de trabalho.",
  "entityId is not a checklist in this workspace":
    "entityId não é uma checklist deste espaço de trabalho.",
  "entityId is not a checklist item in this workspace":
    "entityId não é um item de checklist deste espaço de trabalho.",
  "entityId is not a comment in this workspace":
    "entityId não é um comentário deste espaço de trabalho.",
  "entityId is not an attachment in this workspace":
    "entityId não é um anexo deste espaço de trabalho.",
  "expected a single option":
    "Era esperada uma única opção.",
  "expected a single user":
    "Era esperado um único usuário.",
  "external link not found":
    "Link externo não encontrado.",
  "failed to persist web push configuration":
    "Não foi possível salvar a configuração de notificações push da web.",
  "file too large":
    "O arquivo é grande demais.",
  "following and reminders need a personal API key or OAuth connection":
    "Acompanhar cartões e lembretes exige uma chave de API pessoal ou uma conexão OAuth.",
  "import columns cannot be changed now":
    "As colunas da importação não podem mais ser alteradas.",
  "import is not ready to commit":
    "A importação ainda não está pronta para ser confirmada.",
  "import not found":
    "Importação não encontrada.",
  "imports cannot create a second board in a standalone board":
    "Importações não podem criar um segundo quadro em um quadro independente.",
  "inline media from integrations must be uploaded to Kanera before embedding":
    "Mídias incorporadas de integrações precisam ser enviadas ao Kanera antes de serem incorporadas.",
  "invalid Discord webhook url":
    "A URL do webhook do Discord é inválida.",
  "invalid MCP service credential":
    "A credencial do serviço MCP é inválida.",
  "invalid Slack incoming webhook url":
    "A URL do webhook de entrada do Slack é inválida.",
  "invalid Telegram credentials":
    "As credenciais do Telegram são inválidas.",
  "invalid activity cursor":
    "O cursor de atividade é inválido.",
  "invalid card feed cursor":
    "O cursor do feed de cartões é inválido.",
  "invalid client credentials":
    "As credenciais do cliente são inválidas.",
  "invalid commentId":
    "commentId é inválido.",
  "invalid completed cards cursor":
    "O cursor de cartões concluídos é inválido.",
  "invalid credentials":
    "As credenciais são inválidas.",
  "invalid current password":
    "A senha atual está incorreta.",
  "invalid invite":
    "O convite é inválido.",
  "invalid notification destination url":
    "A URL do destino de notificações é inválida.",
  "invalid or expired MCP access token":
    "O token de acesso do MCP é inválido ou expirou.",
  "invalid or expired challenge":
    "O desafio é inválido ou expirou.",
  "invalid or expired invitation":
    "O convite é inválido ou expirou.",
  "invalid or expired verification code":
    "O código de verificação é inválido ou expirou.",
  "invalid password":
    "A senha está incorreta.",
  "invalid refresh token":
    "O token de atualização é inválido.",
  "invalid reset token":
    "O token de redefinição é inválido.",
  "invalid source":
    "A origem é inválida.",
  "invalid status (expected pending|dispatched)":
    "O status é inválido (esperado: pending|dispatched).",
  "invalid status":
    "O status é inválido.",
  "invalid verification code":
    "O código de verificação é inválido.",
  "invalid webhook url":
    "A URL do webhook é inválida.",
  "invalid work cursor":
    "O cursor de trabalho é inválido.",
  "invalid work-done day range":
    "O intervalo de dias do trabalho concluído é inválido.",
  "invalid work-history cursor":
    "O cursor do histórico de trabalho é inválido.",
  "invitation already accepted":
    "O convite já foi aceito.",
  "items in nested checklists do not support descriptions":
    "Itens de checklists aninhadas não aceitam descrições.",
  "label mapping target not found in workspace":
    "Destino de mapeamento da etiqueta não encontrado no espaço de trabalho.",
  "label not in workspace":
    "A etiqueta não está no espaço de trabalho.",
  "limit must be a positive integer":
    "limit deve ser um número inteiro positivo.",
  "list mapping target not found in workspace":
    "Destino de mapeamento da lista não encontrado no espaço de trabalho.",
  "list not in workspace":
    "A lista não está no espaço de trabalho.",
  "listId must identify a list in the monitored workspace":
    "listId deve identificar uma lista do espaço de trabalho monitorado.",
  "member mapping target not found in workspace":
    "Destino de mapeamento do membro não encontrado no espaço de trabalho.",
  "nested checklist items do not support assignees or due dates":
    "Itens aninhados da checklist não aceitam responsáveis nem datas de entrega.",
  "nested checklist items do not support descriptions":
    "Itens aninhados da checklist não aceitam descrições.",
  "nested checklist items support only text and completion":
    "Itens aninhados da checklist aceitam apenas texto e conclusão.",
  "no active organisation membership":
    "Você não tem nenhuma associação ativa a uma organização.",
  "no file uploaded":
    "Nenhum arquivo foi enviado.",
  "note has changed since editing started":
    "A nota mudou desde que a edição começou.",
  "note is being edited by another user":
    "Outro usuário está editando a nota.",
  "note tree contains a cycle":
    "A árvore de notas contém um ciclo.",
  "notes are disabled for this workspace":
    "As notas estão desativadas para este espaço de trabalho.",
  "notes can only be nested 3 levels deep":
    "As notas só podem ser aninhadas em até 3 níveis.",
  "notification destination host is not allowed":
    "O host do destino de notificações não é permitido.",
  "notification destination host resolves to a blocked address":
    "O host do destino de notificações aponta para um endereço bloqueado.",
  "notification destination url must not contain a fragment":
    "A URL do destino de notificações não deve conter um fragmento.",
  "notification destination url must not contain credentials":
    "A URL do destino de notificações não deve conter credenciais.",
  "notification server url must not contain a query string":
    "A URL do servidor de notificações não deve conter uma query string.",
  "ntfy requires a server URL and topic":
    "O ntfy exige uma URL de servidor e um tópico.",
  "one or more action checklist template ids are invalid":
    "Um ou mais IDs de modelo de checklist da ação são inválidos.",
  "one or more action label ids are invalid":
    "Um ou mais IDs de etiqueta da ação são inválidos.",
  "one or more action list ids are invalid":
    "Um ou mais IDs de lista da ação são inválidos.",
  "one or more action user ids are not assignable workspace members":
    "Um ou mais IDs de usuário da ação não são membros do espaço de trabalho que podem ser atribuídos.",
  "one or more action webhook endpoint ids are invalid":
    "Um ou mais IDs de endpoint de webhook da ação são inválidos.",
  "one or more card ids are not in this board":
    "Um ou mais IDs de cartão não estão neste quadro.",
  "one or more cards were not found on this board":
    "Um ou mais cartões não foram encontrados neste quadro.",
  "one or more checklist item ids do not match the supplied board, card, or checklist":
    "Um ou mais IDs de item de checklist não correspondem ao quadro, cartão ou checklist informados.",
  "one or more checklists were not found on their cards":
    "Uma ou mais checklists não foram encontradas nos seus cartões.",
  "one or more label ids are invalid":
    "Um ou mais IDs de etiqueta são inválidos.",
  "one or more set custom field ids are invalid":
    "Um ou mais IDs de campo personalizado a definir são inválidos.",
  "one or more source lists are not in the source workspace":
    "Uma ou mais listas de origem não estão no espaço de trabalho de origem.",
  "one or more target lists are not in the target workspace":
    "Uma ou mais listas de destino não estão no espaço de trabalho de destino.",
  "one or more trigger user ids are not assignable workspace members":
    "Um ou mais IDs de usuário do gatilho não são membros do espaço de trabalho que podem ser atribuídos.",
  "one or more user ids are not assignable members":
    "Um ou mais IDs de usuário não são membros que podem ser atribuídos.",
  "only an owner can change owner roles":
    "Apenas um proprietário pode alterar funções de proprietário.",
  "only an owner can remove an owner":
    "Apenas um proprietário pode remover outro proprietário.",
  "only failed deliveries can be retried":
    "Apenas entregas com falha podem ser repetidas.",
  "only failed emails can be retried":
    "Apenas e-mails com falha podem ser repetidos.",
  "only failed push notifications can be retried":
    "Apenas notificações push com falha podem ser repetidas.",
  "only failed webhook deliveries can be retried":
    "Apenas entregas de webhook com falha podem ser repetidas.",
  "only pending emails can be cancelled":
    "Apenas e-mails pendentes podem ser cancelados.",
  "only pending outbox events can be cancelled":
    "Apenas eventos pendentes da caixa de saída podem ser cancelados.",
  "only pending outbox events can be retried":
    "Apenas eventos pendentes da caixa de saída podem ser repetidos.",
  "only pending push notifications can be cancelled":
    "Apenas notificações push pendentes podem ser canceladas.",
  "only pending webhook deliveries can be cancelled":
    "Apenas entregas de webhook pendentes podem ser canceladas.",
  "only user sessions can create an organisation":
    "Apenas sessões de usuário podem criar uma organização.",
  "only user sessions can delete an organisation":
    "Apenas sessões de usuário podem excluir uma organização.",
  "option not found":
    "Opção não encontrada.",
  "options are only valid for select fields":
    "Opções só são válidas para campos de seleção.",
  "organisation is unavailable for billing":
    "A organização não está disponível para cobrança.",
  "organisation membership is not active":
    "A associação à organização não está ativa.",
  "organisation membership not found":
    "Associação à organização não encontrada.",
  "organisation name does not match":
    "O nome da organização não corresponde.",
  "organisation not found":
    "Organização não encontrada.",
  "organisation owners and admins already inherit standalone board access":
    "Proprietários e administradores da organização já herdam o acesso a quadros independentes.",
  "organisation owners and admins are always workspace admins":
    "Proprietários e administradores da organização são sempre administradores do espaço de trabalho.",
  "organisation owners and admins cannot be removed from a workspace":
    "Proprietários e administradores da organização não podem ser removidos de um espaço de trabalho.",
  "outbox event not found":
    "Evento da caixa de saída não encontrado.",
  "paid plans require trialing, active, or past_due billing status":
    "Planos pagos exigem o status de cobrança trialing, active ou past_due.",
  "parent note in different scope":
    "A nota principal está em outro escopo.",
  "parent note not found":
    "Nota principal não encontrada.",
  "parentItemId must identify a top-level item on this card":
    "parentItemId deve identificar um item de nível superior deste cartão.",
  "pending invitation not found":
    "Convite pendente não encontrado.",
  "plan changes are only available in hosted mode":
    "Mudanças de plano só estão disponíveis no modo hospedado.",
  "priority anchor is not visible":
    "A âncora de prioridade não está visível.",
  "priority field must be an active select or text field in this workspace":
    "O campo de prioridade deve ser um campo de seleção ou de texto ativo neste espaço de trabalho.",
  "provide ids to add or remove":
    "Informe os IDs a adicionar ou remover.",
  "public board card reads require listId and cardLimit; use includeCards=false for board metadata":
    "Leituras de cartões de quadros públicos exigem listId e cardLimit. Use includeCards=false para obter os metadados do quadro.",
  "push messaging is managed by the hosted deployment":
    "As mensagens push são gerenciadas pela implantação hospedada.",
  "push notification not found":
    "Notificação push não encontrada.",
  "rate limit exceeded":
    "Limite de solicitações excedido.",
  "redirect URIs must use HTTPS, except localhost callbacks":
    "URIs de redirecionamento devem usar HTTPS, exceto callbacks de localhost.",
  "redirect_uri is not registered":
    "redirect_uri não está registrada.",
  "refresh token client mismatch":
    "O token de atualização não corresponde a este cliente.",
  "refresh token reuse or expiry detected":
    "Foi detectado reúso ou expiração do token de atualização.",
  "refresh_token is not allowed for this client":
    "refresh_token não é permitido para este cliente.",
  "refresh_token is required":
    "refresh_token é obrigatório.",
  "remindAt must be in the future":
    "remindAt deve estar no futuro.",
  "requested scope exceeds the service connection maximum":
    "O escopo solicitado excede o máximo da conexão de serviço.",
  "resource is required":
    "resource é obrigatório.",
  "scratchpad page has changed since it was read":
    "A página do bloco de rascunho mudou desde que foi lida.",
  "secretAccessKey required":
    "secretAccessKey é obrigatório.",
  "security challenge failed":
    "A verificação de segurança falhou.",
  "security challenge required":
    "A verificação de segurança é obrigatória.",
  "set custom field copy source is invalid":
    "A origem da cópia do campo personalizado é inválida.",
  "set custom field value does not match field type":
    "O valor do campo personalizado não corresponde ao tipo do campo.",
  "share target must be an active user in your organisation":
    "O destinatário deve ser um usuário ativo da sua organização.",
  "since must be a cursor returned by a previous call":
    "since deve ser um cursor retornado por uma chamada anterior.",
  "smtp is configured by environment variables":
    "O SMTP é configurado por variáveis de ambiente.",
  "smtp is configured by the hosted deployment":
    "O SMTP é configurado pela implantação hospedada.",
  "smtp password required":
    "A senha do SMTP é obrigatória.",
  "smtpConfig required":
    "smtpConfig é obrigatório.",
  "source lists must be unique":
    "As listas de origem devem ser únicas.",
  "standalone board configuration must contain exactly one board":
    "A configuração de um quadro independente deve conter exatamente um quadro.",
  "standalone board import target not found":
    "Destino de importação do quadro independente não encontrado.",
  "standalone boards cannot contain another board":
    "Quadros independentes não podem conter outro quadro.",
  "storage is configured by environment variables":
    "O armazenamento é configurado por variáveis de ambiente.",
  "storage is configured by the hosted deployment":
    "O armazenamento é configurado pela implantação hospedada.",
  "storageConfig required":
    "storageConfig é obrigatório.",
  "subscription limit reached":
    "Limite de assinaturas atingido.",
  "subscription not found":
    "Assinatura não encontrada.",
  "superadmin required":
    "É necessário ser superadministrador.",
  "support session not found":
    "Sessão de suporte não encontrada.",
  "switch organisation to access this resource":
    "Mude de organização para acessar este recurso.",
  "target board must be in the same workspace":
    "O quadro de destino deve estar no mesmo espaço de trabalho.",
  "target board must differ from current board":
    "O quadro de destino deve ser diferente do quadro atual.",
  "target checklist must have the same parent item":
    "A checklist de destino deve ter o mesmo item principal.",
  "target checklist not on this card":
    "A checklist de destino não está neste cartão.",
  "target is not a removable board guest":
    "O destino não é um convidado do quadro que pode ser removido.",
  "target list not in board workspace":
    "A lista de destino não está no espaço de trabalho do quadro.",
  "target list not in same workspace":
    "A lista de destino não está no mesmo espaço de trabalho.",
  "target list not in workspace":
    "A lista de destino não está no espaço de trabalho.",
  "target list required":
    "A lista de destino é obrigatória.",
  "target org not found or has no active owner to act as":
    "Organização de destino não encontrada ou sem um proprietário ativo em nome de quem agir.",
  "target user not found":
    "Usuário de destino não encontrado.",
  "targetListId is required for cross-workspace mirrors":
    "targetListId é obrigatório para espelhos entre espaços de trabalho.",
  "targetListId must differ from source list":
    "targetListId deve ser diferente da lista de origem.",
  "telegram requires a bot token and chat id":
    "O Telegram exige um token de bot e um ID de chat.",
  "that is already your email address":
    "Esse já é o seu endereço de e-mail.",
  "the credential that created this upload link is no longer valid":
    "A credencial que criou este link de upload não é mais válida.",
  "the final active superadmin cannot be disabled":
    "O último superadministrador ativo não pode ser desativado.",
  "the mirror provider namespace is reserved":
    "O namespace do provedor de espelhos é reservado.",
  "the notification inbox needs a personal API key or OAuth connection":
    "A caixa de notificações exige uma chave de API pessoal ou uma conexão OAuth.",
  "the owner already has access":
    "O proprietário já tem acesso.",
  "the scratchpad needs a personal API key or OAuth connection":
    "O bloco de rascunho exige uma chave de API pessoal ou uma conexão OAuth.",
  "this GitHub installation is not accessible to the authorizing GitHub user":
    "Esta instalação do GitHub não está acessível ao usuário do GitHub que está autorizando.",
  "this board mirror already exists":
    "Este espelho do quadro já existe.",
  "this guest must subscribe to an assigned card":
    "Este convidado precisa acompanhar um cartão atribuído.",
  "this invitation was sent to a different email address":
    "Este convite foi enviado para outro endereço de e-mail.",
  "too many attempts; request a new code":
    "Tentativas demais. Solicite um novo código.",
  "triggerCustomFieldId and triggerCustomFieldValue are required":
    "triggerCustomFieldId e triggerCustomFieldValue são obrigatórios.",
  "triggerDaysBefore is required":
    "triggerDaysBefore é obrigatório.",
  "triggerLabelId is required":
    "triggerLabelId é obrigatório.",
  "triggerListId is required":
    "triggerListId é obrigatório.",
  "triggerUserIds is required":
    "triggerUserIds é obrigatório.",
  "unknown event":
    "Evento desconhecido.",
  "unknown option for custom field trigger":
    "Opção desconhecida para o gatilho do campo personalizado.",
  "unknown option for set custom field action":
    "Opção desconhecida para a ação de definir campo personalizado.",
  "unknown option for this field":
    "Opção desconhecida para este campo.",
  "unknown or revoked OAuth client":
    "Cliente OAuth desconhecido ou revogado.",
  "unsubscribe link is invalid":
    "O link de cancelamento de inscrição é inválido.",
  "unsupported OAuth resource":
    "Recurso OAuth não suportado.",
  "unsupported OAuth scope":
    "Escopo OAuth não suportado.",
  "unsupported delivery mode":
    "Modo de entrega não suportado.",
  "unsupported file type":
    "Tipo de arquivo não suportado.",
  "unsupported file type; pass a supported mimeType or a file name with a supported extension":
    "Tipo de arquivo não suportado. Informe um mimeType suportado ou um nome de arquivo com uma extensão suportada.",
  "unsupported grant_type":
    "grant_type não suportado.",
  "upload a CSV file":
    "Envie um arquivo CSV.",
  "upload a Kanera board JSON export":
    "Envie uma exportação JSON de um quadro do Kanera.",
  "upload a Trello JSON export":
    "Envie uma exportação JSON do Trello.",
  "upload body is empty":
    "O corpo do upload está vazio.",
  "upload link is invalid, expired, or already used; create a new one":
    "O link de upload é inválido, expirou ou já foi usado. Crie um novo.",
  "use /billing/checkout to start a Stripe checkout session":
    "Use /billing/checkout para iniciar uma sessão de pagamento do Stripe.",
  "use /billing/portal to manage or cancel a Stripe subscription":
    "Use /billing/portal para gerenciar ou cancelar uma assinatura do Stripe.",
  "use add/remove for multi-value fields":
    "Use add/remove para campos com vários valores.",
  "use the leave organisation action to remove yourself":
    "Use a ação de sair da organização para remover a si mesmo.",
  "user is already a board member":
    "O usuário já é membro do quadro.",
  "user is already a workspace member":
    "O usuário já é membro do espaço de trabalho.",
  "user is not a workspace member":
    "O usuário não é membro do espaço de trabalho.",
  "user is not visible in the selected work scope":
    "O usuário não está visível no escopo de trabalho selecionado.",
  "user not found":
    "Usuário não encontrado.",
  "users already associated with this organisation cannot accept board guest invites":
    "Usuários já associados a esta organização não podem aceitar convites de convidado para quadros.",
  "users already in this organisation cannot accept board guest invites":
    "Usuários que já estão nesta organização não podem aceitar convites de convidado para quadros.",
  "variant must be original, cover, or thumbnail":
    "variant deve ser original, cover ou thumbnail.",
  "verification code required":
    "O código de verificação é obrigatório.",
  "webhook not found":
    "Webhook não encontrado.",
  "webhook requires a URL and signing secret":
    "O webhook exige uma URL e um segredo de assinatura.",
  "webhook url host is not allowed":
    "O host da URL do webhook não é permitido.",
  "webhook url host resolves to a blocked address":
    "O host da URL do webhook aponta para um endereço bloqueado.",
  "webhook url must use http(s)":
    "A URL do webhook deve usar http(s).",
  "webhook url must use https":
    "A URL do webhook deve usar https.",
  "work view not found":
    "Visualização de trabalho não encontrada.",
  "work-done day cannot be in the future":
    "O dia de trabalho concluído não pode estar no futuro.",
  "work-history cursor does not match this query":
    "O cursor do histórico de trabalho não corresponde a esta consulta.",
  "workspace name does not match":
    "O nome do espaço de trabalho não corresponde.",
  "workspace not found":
    "Espaço de trabalho não encontrado.",
  "workspace not in your organisation":
    "O espaço de trabalho não está na sua organização.",
  "write-capable credential required":
    "É necessária uma credencial com permissão de escrita.",
  "you are already a member of this organisation":
    "Você já é membro desta organização.",
  "you cannot disable your own account":
    "Você não pode desativar sua própria conta.",
  "you cannot reset your own MFA":
    "Você não pode redefinir sua própria MFA.",
  "your membership of this organisation is suspended":
    "Sua associação a esta organização está suspensa.",
  "validation failed":
    "A validação falhou.",
  "internal error":
    "Ocorreu um erro interno.",
  "forbidden":
    "Você não tem permissão para fazer isso.",
  "not found":
    "Não encontrado.",
  "conflict":
    "Ocorreu um conflito.",
  "bad request":
    "Solicitação inválida.",
  "unauthorized":
    "Não autorizado.",
  "web push is not configured":
    "As notificações push da web não estão configuradas.",
  "push messages are disabled for this organisation":
    "As mensagens push estão desativadas para esta organização.",
  "provide dueDateLocalDate when setting dueDateSlot":
    "Informe dueDateLocalDate ao definir dueDateSlot.",
  "cannot leave as the last owner":
    "Você não pode sair sendo o último proprietário.",
  "cannot remove the last owner":
    "Não é possível remover o último proprietário.",
  "notification destination url must use http(s)":
    "A URL do destino de notificações deve usar http(s).",
  "notification destination url must use https":
    "A URL do destino de notificações deve usar https.",
  "invalid authorization code":
    "O código de autorização é inválido.",
  "authorization grant is revoked":
    "A concessão de autorização foi revogada.",
  "Request body is too large":
    "O corpo da solicitação é grande demais.",
  "Unsupported Media Type":
    "Tipo de mídia não suportado.",
  "Request body size did not match Content-Length":
    "O tamanho do corpo da solicitação não corresponde ao Content-Length.",
  "Body cannot be empty when content-type is set to 'application/json'":
    "O corpo não pode estar vazio quando o content-type é 'application/json'.",
  "Body is not valid JSON but content-type is set to 'application/json'":
    "O corpo não é um JSON válido, mas o content-type é 'application/json'.",
  "Your plan's boards limit has been reached. Upgrade to add more.":
    "O limite de quadros do seu plano foi atingido. Faça upgrade para adicionar mais.",
  "Your plan's members limit has been reached. Upgrade to add more.":
    "O limite de membros do seu plano foi atingido. Faça upgrade para adicionar mais.",
  "Your plan's enabled automations limit has been reached. Upgrade to add more.":
    "O limite de automações ativas do seu plano foi atingido. Faça upgrade para adicionar mais.",
  "This organisation is on the Free plan, which allows your AI agents and API keys {limit} requests per second on its boards, and the request queue is full. Retry shortly; Kanera Pro raises these limits.":
    "Esta organização está no plano Free, que permite aos seus agentes de IA e chaves de API {limit} solicitações por segundo nos quadros dela, e a fila de solicitações está cheia. Tente novamente em instantes; o Kanera Pro aumenta esses limites.",
  "This organisation is on the Free plan, which allows your AI agents and API keys {limit} requests per minute on its boards. Retry shortly; Kanera Pro raises these limits.":
    "Esta organização está no plano Free, que permite aos seus agentes de IA e chaves de API {limit} solicitações por minuto nos quadros dela. Tente novamente em instantes; o Kanera Pro aumenta esses limites.",
  "{field} not found":
    "{field} não encontrado.",
  "{type} anchor not found":
    "Âncora {type} não encontrada.",
  "{provider} requires a webhook url":
    "{provider} exige uma URL de webhook.",
  "CSV column {column} does not exist":
    "A coluna {column} do CSV não existe.",
  "CSV exceeds the {max} column limit":
    "O CSV excede o limite de {max} colunas.",
  "CSV exceeds the {max} row limit":
    "O CSV excede o limite de {max} linhas.",
  "File is too large. The maximum file size is {size}.":
    "O arquivo é grande demais. O tamanho máximo de arquivo é {size}.",
  "Workspaces can have up to {max} automations. Contact support if you need more.":
    "Espaços de trabalho podem ter até {max} automações. Fale com o suporte se precisar de mais.",
  "Your organisation has used its {quota} storage allowance. Upgrade the plan or remove files to upload more.":
    "Sua organização usou todo o armazenamento de {quota}. Faça upgrade do plano ou remova arquivos para enviar mais.",
  "a priority queue holds at most {max} cards":
    "Uma fila de prioridades comporta no máximo {max} cartões.",
  "a scratchpad holds at most {max} pages":
    "Um bloco de rascunho comporta no máximo {max} páginas.",
  "a scratchpad holds at most {max} pages; capture to an existing page title":
    "Um bloco de rascunho comporta no máximo {max} páginas. Capture no título de uma página existente.",
  "automation action checklist template not found: {name}":
    "Modelo de checklist da ação de automação não encontrado: {name}",
  "automation action custom field not found: {name}":
    "Campo personalizado da ação de automação não encontrado: {name}",
  "automation action custom field option not found: {name}":
    "Opção de campo personalizado da ação de automação não encontrada: {name}",
  "automation action label not found: {name}":
    "Etiqueta da ação de automação não encontrada: {name}",
  "automation action list not found: {name}":
    "Lista da ação de automação não encontrada: {name}",
  "automation trigger label not found: {name}":
    "Etiqueta do gatilho de automação não encontrada: {name}",
  "automation trigger list not found: {name}":
    "Lista do gatilho de automação não encontrada: {name}",
  "starter card checklist template not found: {name}":
    "Modelo de checklist do cartão inicial não encontrado: {name}",
  "starter card label not found: {name}":
    "Etiqueta do cartão inicial não encontrada: {name}",
  "starter card list not found: {name}":
    "Lista do cartão inicial não encontrada: {name}",
  "bulk delete only removes comments you authored; not authored by you: {ids}":
    "A exclusão em massa remove apenas comentários escritos por você. Não escritos por você: {ids}",
  "cannot delete the last owner of {orgName}":
    "Não é possível excluir o último proprietário de {orgName}.",
  "cards[{index}]: {message}":
    "cards[{index}]: {message}",
  "comments not found on this board: {ids}":
    "Comentários não encontrados neste quadro: {ids}",
  "could not parse CSV: {reason}":
    "Não foi possível ler o CSV: {reason}",
  "could not parse Kanera JSON: {reason}":
    "Não foi possível ler o JSON do Kanera: {reason}",
  "could not parse Trello JSON: {reason}":
    "Não foi possível ler o JSON do Trello: {reason}",
  "expected {type} value":
    "Era esperado um valor do tipo {type}.",
  "invalid {provider} credentials":
    "As credenciais do {provider} são inválidas.",
  "remindAt must be within {days} days":
    "remindAt deve estar dentro dos próximos {days} dias.",
  "this attachment has no {variant} image":
    "Este anexo não tem uma imagem {variant}.",
  "work-done history is limited to the last {days} days":
    "O histórico de trabalho concluído é limitado aos últimos {days} dias.",
};
