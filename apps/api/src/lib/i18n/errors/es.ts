import type { ErrorCatalog } from "./source.js";

// es translations of the API error catalog. Terms and voice follow apps/web/src/locale/GLOSSARY.md.
export const es: ErrorCatalog = {
  "AI agent access is turned off for this organisation":
    "El acceso de agentes de IA está desactivado para esta organización.",
  "Additional notification destinations are not available on your plan. Upgrade to configure ntfy, Gotify, or a personal webhook.":
    "Los destinos de notificación adicionales no están disponibles en tu plan. Mejora tu plan para configurar ntfy, Gotify o un webhook personal.",
  "All purchased seats are in use. Buy more seats to add this person.":
    "Todos los puestos comprados están en uso. Compra más puestos para añadir a esta persona.",
  "An account already exists for this email. Sign in to accept the invite.":
    "Ya existe una cuenta con este correo electrónico. Inicia sesión para aceptar la invitación.",
  "Billing cancellation could not be confirmed, so the organisation was not deleted. Please try again.":
    "No se pudo confirmar la cancelación de la facturación, así que la organización no se eliminó. Inténtalo de nuevo.",
  "Board syncing requires Pro in both participating organisations.":
    "La sincronización de tableros requiere Pro en ambas organizaciones participantes.",
  "CSV did not contain any rows":
    "El CSV no contenía ninguna fila.",
  "Device code is invalid or expired":
    "El código de dispositivo no es válido o ha caducado.",
  "GitHub App is already configured through the deployment environment":
    "La GitHub App ya está configurada en el entorno de despliegue.",
  "GitHub App is configured through the deployment environment":
    "La GitHub App se configura en el entorno de despliegue.",
  "GitHub App is not configured":
    "La GitHub App no está configurada.",
  "GitHub App manifest could not be completed":
    "No se pudo completar el manifiesto de la GitHub App.",
  "GitHub App not found":
    "No se encontró la GitHub App.",
  "GitHub App setup is managed by the hosted deployment":
    "La configuración de la GitHub App la gestiona el despliegue alojado.",
  "GitHub App user authorization is not configured for this deployment":
    "La autorización de usuario de la GitHub App no está configurada en este despliegue.",
  "GitHub installation could not be verified":
    "No se pudo verificar la instalación de GitHub.",
  "GitHub installation not found":
    "No se encontró la instalación de GitHub.",
  "GitHub manifest state did not match this organisation":
    "El estado del manifiesto de GitHub no coincide con esta organización.",
  "GitHub user authorization could not be verified":
    "No se pudo verificar la autorización de usuario de GitHub.",
  "GitHub user authorization is required to connect an installation":
    "Se requiere la autorización de usuario de GitHub para conectar una instalación.",
  "Global Work layout anchors are not available through this API":
    "Los anclajes de diseño de Global Work no están disponibles en esta API.",
  "Gotify requires a server URL and app token":
    "Gotify requiere una URL de servidor y un token de aplicación.",
  "Guests are not available on your plan. Upgrade to invite guests.":
    "Los invitados no están disponibles en tu plan. Mejora tu plan para invitar a invitados.",
  "Idempotency-Key must contain 1 to 255 visible ASCII characters":
    "Idempotency-Key debe contener entre 1 y 255 caracteres ASCII visibles.",
  "Idempotency-Key was already used for a different request":
    "Idempotency-Key ya se usó para otra solicitud.",
  "Invalid Stripe webhook signature":
    "La firma del webhook de Stripe no es válida.",
  "Invalid Stripe webhook":
    "El webhook de Stripe no es válido.",
  "Kanera export did not contain any lists":
    "La exportación de Kanera no contenía ninguna lista.",
  "MCP policy applies to hosted organisations only":
    "La política de MCP solo se aplica a organizaciones alojadas.",
  "MCP subscriptions require an API or OAuth credential":
    "Las suscripciones de MCP requieren una credencial de API u OAuth.",
  "MFA enrollment is not required":
    "No es necesario configurar la MFA.",
  "MFA is required by this organisation":
    "Esta organización requiere MFA.",
  "MFA is required by your organisation":
    "Tu organización requiere MFA.",
  "No Stripe customer exists for this organisation":
    "No existe ningún cliente de Stripe para esta organización.",
  "No Stripe subscription exists for this organisation":
    "No existe ninguna suscripción de Stripe para esta organización.",
  "No pending seat payment to confirm":
    "No hay ningún pago de puestos pendiente de confirmar.",
  "OAuth connection not found":
    "No se encontró la conexión OAuth.",
  "Organisation members are added directly to the board, not invited as guests.":
    "Los miembros de la organización se añaden directamente al tablero, no se invitan como invitados.",
  "Seat capacity can only be changed for paid subscriptions":
    "La cantidad de puestos solo se puede cambiar en suscripciones de pago.",
  "Signups are currently disabled.":
    "Los registros están desactivados en este momento.",
  "Stripe did not return a checkout URL":
    "Stripe no devolvió una URL de pago.",
  "Stripe is not configured":
    "Stripe no está configurado.",
  "Stripe price is not configured":
    "El precio de Stripe no está configurado.",
  "Stripe webhook secret is not configured":
    "El secreto del webhook de Stripe no está configurado.",
  "The invited boards are no longer available.":
    "Los tableros a los que se te invitó ya no están disponibles.",
  "There is already a pending invite for this email and board.":
    "Ya hay una invitación pendiente para este correo electrónico y este tablero.",
  "This board invitation is invalid or has expired.":
    "Esta invitación al tablero no es válida o ha caducado.",
  "This invitation was sent to a different email address. Sign up with the invited address.":
    "Esta invitación se envió a otra dirección de correo electrónico. Regístrate con la dirección invitada.",
  "This person already has access to this board.":
    "Esta persona ya tiene acceso a este tablero.",
  "Trello export did not contain any lists":
    "La exportación de Trello no contenía ninguna lista.",
  "Update your billing details before adding seats.":
    "Actualiza tus datos de facturación antes de añadir puestos.",
  "We haven't received confirmation of your payment yet. Complete it and try again.":
    "Aún no hemos recibido la confirmación de tu pago. Complétalo e inténtalo de nuevo.",
  "Webhooks are not available on your plan. Upgrade to create webhooks.":
    "Los webhooks no están disponibles en tu plan. Mejora tu plan para crear webhooks.",
  "Workspace API keys and unattended AI agents are not available on your plan. Upgrade to create them, or use a personal API key or interactive agent connection.":
    "Las claves de API del espacio de trabajo y los agentes de IA desatendidos no están disponibles en tu plan. Mejora tu plan para crearlos o usa una clave de API personal o una conexión de agente interactiva.",
  "You have more assigned seats than that — remove members or guests first.":
    "Tienes más puestos asignados que esa cantidad. Primero elimina miembros o invitados.",
  "Your payment method needs attention before we can add seats. Update your payment method, then try again.":
    "Tu método de pago requiere atención antes de que podamos añadir puestos. Actualiza tu método de pago e inténtalo de nuevo.",
  "a board cannot be both a mirror source and a mirror target":
    "Un tablero no puede ser a la vez origen y destino de un espejo.",
  "a board cannot mirror itself":
    "Un tablero no puede reflejarse a sí mismo.",
  "a checklist changed while preparing the batch; retry with fresh content":
    "Una lista de verificación cambió mientras se preparaba el lote. Vuelve a intentarlo con el contenido actualizado.",
  "a checklist item changed while applying the batch; retry with fresh content":
    "Un elemento de la lista cambió mientras se aplicaba el lote. Vuelve a intentarlo con el contenido actualizado.",
  "a comment changed while applying the batch; retry with a fresh comment list":
    "Un comentario cambió mientras se aplicaba el lote. Vuelve a intentarlo con una lista de comentarios actualizada.",
  "a demo reset is already running":
    "Ya hay un restablecimiento de demostración en curso.",
  "accessKeyId required":
    "Se requiere accessKeyId.",
  "account disabled":
    "La cuenta está desactivada.",
  "activity cursor does not match this board":
    "El cursor de actividad no corresponde a este tablero.",
  "add/remove is only valid for multi-value select or user fields":
    "Añadir o quitar solo es válido para campos de selección múltiple o de usuario.",
  "administrator not found":
    "No se encontró el administrador.",
  "afterChecklistId not found":
    "No se encontró afterChecklistId.",
  "afterItemId not found":
    "No se encontró afterItemId.",
  "agent connection not found":
    "No se encontró la conexión del agente.",
  "agent run has already ended":
    "La ejecución del agente ya terminó.",
  "agent run not found":
    "No se encontró la ejecución del agente.",
  "an administrator with this email already exists":
    "Ya existe un administrador con este correo electrónico.",
  "an idempotent request with this key is already in progress":
    "Ya hay una solicitud idempotente con esta clave en curso.",
  "anchor page not found":
    "No se encontró la página de referencia.",
  "api key not found":
    "No se encontró la clave de API.",
  "archived cards are read-only":
    "Las tarjetas archivadas son de solo lectura.",
  "archived source lists cannot be mirrored":
    "Las listas de origen archivadas no se pueden reflejar.",
  "archived target lists cannot be selected":
    "Las listas de destino archivadas no se pueden seleccionar.",
  "assignee is not an assignable member":
    "El responsable no es un miembro asignable.",
  "attachment storage unavailable":
    "El almacenamiento de archivos adjuntos no está disponible.",
  "authorization_code is not allowed for this client":
    "authorization_code no está permitido para este cliente.",
  "beforeChecklistId not found":
    "No se encontró beforeChecklistId.",
  "beforeItemId not found":
    "No se encontró beforeItemId.",
  "billing is only available in hosted mode":
    "La facturación solo está disponible en el modo alojado.",
  "board group not found":
    "No se encontró el grupo de tableros.",
  "board is not a standalone board":
    "El tablero no es un tablero independiente.",
  "board linking is disabled for one or more participating workspaces":
    "La vinculación de tableros está desactivada en uno o más de los espacios de trabajo participantes.",
  "board membership not found":
    "No se encontró la membresía del tablero.",
  "board mirror not found":
    "No se encontró el espejo del tablero.",
  "board not found":
    "No se encontró el tablero.",
  "board not in same workspace":
    "El tablero no está en el mismo espacio de trabajo.",
  "board ordering anchor not found":
    "No se encontró el anclaje de orden del tablero.",
  "boardId is required":
    "Se requiere boardId.",
  "callback verification failed":
    "No se pudo verificar la URL de retorno.",
  "cannot change an inherited board admin role":
    "No se puede cambiar un rol de administrador del tablero heredado.",
  "cannot change your own role":
    "No puedes cambiar tu propio rol.",
  "cannot demote the last owner":
    "No se puede degradar al último propietario.",
  "cannot react to your own attachment":
    "No puedes reaccionar a tu propio archivo adjunto.",
  "cannot react to your own comment":
    "No puedes reaccionar a tu propio comentario.",
  "cannot remove an inherited board admin":
    "No se puede quitar a un administrador del tablero heredado.",
  "cannot remove or downgrade the last workspace admin":
    "No se puede quitar ni degradar al último administrador del espacio de trabajo.",
  "cannot remove yourself":
    "No puedes quitarte a ti mismo.",
  "cannot reparent into descendant":
    "No se puede mover un elemento dentro de uno de sus descendientes.",
  "cannot reparent into self":
    "No se puede mover un elemento dentro de sí mismo.",
  "card is already in this queue":
    "La tarjeta ya está en esta cola.",
  "card is completed or archived":
    "La tarjeta está completada o archivada.",
  "card is not assigned to that user":
    "La tarjeta no está asignada a ese usuario.",
  "card is not assigned to the Global Work user":
    "La tarjeta no está asignada al usuario de Global Work.",
  "card key prefix is already reserved":
    "El prefijo de clave de tarjeta ya está reservado.",
  "card key prefix must match ^[A-Z][A-Z0-9]{1,9}$":
    "El prefijo de clave de tarjeta debe coincidir con ^[A-Z][A-Z0-9]{1,9}$.",
  "card must be assigned to the Global Work user":
    "La tarjeta debe estar asignada al usuario de Global Work.",
  "card not found":
    "No se encontró la tarjeta.",
  "cardLimit must be between 1 and 100":
    "cardLimit debe estar entre 1 y 100.",
  "cardOffset must be a non-negative integer":
    "cardOffset debe ser un número entero no negativo.",
  "chat destination not found":
    "No se encontró el destino de chat.",
  "checklist item not found":
    "No se encontró el elemento de la lista.",
  "checklist not found":
    "No se encontró la lista de verificación.",
  "choose a day/month order for ambiguous dates":
    "Elige un orden de día y mes para las fechas ambiguas.",
  "choose a priority custom field":
    "Elige un campo personalizado de prioridad.",
  "client authentication required":
    "Se requiere la autenticación del cliente.",
  "client cannot use this authorization request":
    "El cliente no puede usar esta solicitud de autorización.",
  "client is not a service connection":
    "El cliente no es una conexión de servicio.",
  "client not found":
    "No se encontró el cliente.",
  "client token was already used for another card create":
    "El token de cliente ya se usó para crear otra tarjeta.",
  "code, redirect_uri, and code_verifier are required":
    "Se requieren code, redirect_uri y code_verifier.",
  "configure a webhook URL before rotating its secret":
    "Configura una URL de webhook antes de rotar su secreto.",
  "could not add workspace member":
    "No se pudo añadir el miembro al espacio de trabajo.",
  "could not create board":
    "No se pudo crear el tablero.",
  "could not generate an available card key prefix":
    "No se pudo generar un prefijo de clave de tarjeta disponible.",
  "could not resolve work-history range":
    "No se pudo determinar el rango del historial de trabajo.",
  "cursor does not belong to card comments":
    "El cursor no corresponde a los comentarios de la tarjeta.",
  "custom field mapping target not found":
    "No se encontró el destino de asignación del campo personalizado.",
  "custom field names must be unique within a workspace":
    "Los nombres de los campos personalizados deben ser únicos en un espacio de trabajo.",
  "custom field not found":
    "No se encontró el campo personalizado.",
  "custom field trigger field is invalid":
    "El campo personalizado del activador no es válido.",
  "custom field trigger user is not a workspace member":
    "El usuario del activador del campo personalizado no es miembro del espacio de trabajo.",
  "custom field trigger value does not match field type":
    "El valor del activador del campo personalizado no coincide con el tipo de campo.",
  "delivery not found":
    "No se encontró el envío.",
  "dependencies are disabled for this workspace":
    "Las dependencias están desactivadas en este espacio de trabajo.",
  "destination credentials are required":
    "Se requieren las credenciales del destino.",
  "email already registered":
    "Este correo electrónico ya está registrado.",
  "email not found":
    "No se encontró el correo electrónico.",
  "enable the destination before sending a test":
    "Activa el destino antes de enviar una prueba.",
  "enabled automations require at least one action":
    "Las automatizaciones activas requieren al menos una acción.",
  "enrollment incomplete":
    "La configuración no está completa.",
  "enter a demo password because no existing demo password is available":
    "Introduce una contraseña de demostración, porque no hay ninguna disponible.",
  "entityId is not a card in this workspace":
    "entityId no es una tarjeta de este espacio de trabajo.",
  "entityId is not a checklist in this workspace":
    "entityId no es una lista de verificación de este espacio de trabajo.",
  "entityId is not a checklist item in this workspace":
    "entityId no es un elemento de la lista de este espacio de trabajo.",
  "entityId is not a comment in this workspace":
    "entityId no es un comentario de este espacio de trabajo.",
  "entityId is not an attachment in this workspace":
    "entityId no es un archivo adjunto de este espacio de trabajo.",
  "expected a single option":
    "Se esperaba una sola opción.",
  "expected a single user":
    "Se esperaba un solo usuario.",
  "external link not found":
    "No se encontró el enlace externo.",
  "failed to persist web push configuration":
    "No se pudo guardar la configuración de las notificaciones push web.",
  "file too large":
    "El archivo es demasiado grande.",
  "following and reminders need a personal API key or OAuth connection":
    "Seguir tarjetas y los recordatorios requieren una clave de API personal o una conexión OAuth.",
  "import columns cannot be changed now":
    "Las columnas de la importación ya no se pueden cambiar.",
  "import is not ready to commit":
    "La importación aún no está lista para confirmarse.",
  "import not found":
    "No se encontró la importación.",
  "imports cannot create a second board in a standalone board":
    "Las importaciones no pueden crear un segundo tablero en un tablero independiente.",
  "inline media from integrations must be uploaded to Kanera before embedding":
    "Los medios insertados desde integraciones deben subirse a Kanera antes de insertarlos.",
  "invalid Discord webhook url":
    "La URL del webhook de Discord no es válida.",
  "invalid MCP service credential":
    "La credencial del servicio MCP no es válida.",
  "invalid Slack incoming webhook url":
    "La URL del webhook entrante de Slack no es válida.",
  "invalid Telegram credentials":
    "Las credenciales de Telegram no son válidas.",
  "invalid activity cursor":
    "El cursor de actividad no es válido.",
  "invalid card feed cursor":
    "El cursor del feed de tarjetas no es válido.",
  "invalid client credentials":
    "Las credenciales del cliente no son válidas.",
  "invalid commentId":
    "commentId no es válido.",
  "invalid completed cards cursor":
    "El cursor de tarjetas completadas no es válido.",
  "invalid credentials":
    "Las credenciales no son válidas.",
  "invalid current password":
    "La contraseña actual no es correcta.",
  "invalid invite":
    "La invitación no es válida.",
  "invalid notification destination url":
    "La URL del destino de notificaciones no es válida.",
  "invalid or expired MCP access token":
    "El token de acceso de MCP no es válido o ha caducado.",
  "invalid or expired challenge":
    "El desafío no es válido o ha caducado.",
  "invalid or expired invitation":
    "La invitación no es válida o ha caducado.",
  "invalid or expired verification code":
    "El código de verificación no es válido o ha caducado.",
  "invalid password":
    "La contraseña no es correcta.",
  "invalid refresh token":
    "El token de actualización no es válido.",
  "invalid reset token":
    "El token de restablecimiento no es válido.",
  "invalid source":
    "El origen no es válido.",
  "invalid status (expected pending|dispatched)":
    "El estado no es válido (se esperaba pending|dispatched).",
  "invalid status":
    "El estado no es válido.",
  "invalid verification code":
    "El código de verificación no es válido.",
  "invalid webhook url":
    "La URL del webhook no es válida.",
  "invalid work cursor":
    "El cursor de trabajo no es válido.",
  "invalid work-done day range":
    "El rango de días de trabajo realizado no es válido.",
  "invalid work-history cursor":
    "El cursor del historial de trabajo no es válido.",
  "invitation already accepted":
    "La invitación ya se aceptó.",
  "items in nested checklists do not support descriptions":
    "Los elementos de las listas de verificación anidadas no admiten descripciones.",
  "label mapping target not found in workspace":
    "No se encontró el destino de asignación de la etiqueta en el espacio de trabajo.",
  "label not in workspace":
    "La etiqueta no está en el espacio de trabajo.",
  "limit must be a positive integer":
    "limit debe ser un número entero positivo.",
  "list mapping target not found in workspace":
    "No se encontró el destino de asignación de la lista en el espacio de trabajo.",
  "list not in workspace":
    "La lista no está en el espacio de trabajo.",
  "listId must identify a list in the monitored workspace":
    "listId debe identificar una lista del espacio de trabajo supervisado.",
  "member mapping target not found in workspace":
    "No se encontró el destino de asignación del miembro en el espacio de trabajo.",
  "nested checklist items do not support assignees or due dates":
    "Los elementos anidados de la lista no admiten responsables ni fechas de vencimiento.",
  "nested checklist items do not support descriptions":
    "Los elementos anidados de la lista no admiten descripciones.",
  "nested checklist items support only text and completion":
    "Los elementos anidados de la lista solo admiten texto y completado.",
  "no active organisation membership":
    "No tienes ninguna membresía activa en una organización.",
  "no file uploaded":
    "No se subió ningún archivo.",
  "note has changed since editing started":
    "La nota cambió desde que empezaste a editarla.",
  "note is being edited by another user":
    "Otro usuario está editando la nota.",
  "note tree contains a cycle":
    "El árbol de notas contiene un ciclo.",
  "notes are disabled for this workspace":
    "Las notas están desactivadas para este espacio de trabajo.",
  "notes can only be nested 3 levels deep":
    "Las notas solo se pueden anidar hasta 3 niveles.",
  "notification destination host is not allowed":
    "El host del destino de notificaciones no está permitido.",
  "notification destination host resolves to a blocked address":
    "El host del destino de notificaciones se resuelve en una dirección bloqueada.",
  "notification destination url must not contain a fragment":
    "La URL del destino de notificaciones no debe contener un fragmento.",
  "notification destination url must not contain credentials":
    "La URL del destino de notificaciones no debe contener credenciales.",
  "notification server url must not contain a query string":
    "La URL del servidor de notificaciones no debe contener una cadena de consulta.",
  "ntfy requires a server URL and topic":
    "ntfy requiere una URL de servidor y un tema.",
  "one or more action checklist template ids are invalid":
    "Uno o más ID de plantilla de lista de verificación de la acción no son válidos.",
  "one or more action label ids are invalid":
    "Uno o más ID de etiqueta de la acción no son válidos.",
  "one or more action list ids are invalid":
    "Uno o más ID de lista de la acción no son válidos.",
  "one or more action user ids are not assignable workspace members":
    "Uno o más ID de usuario de la acción no son miembros asignables del espacio de trabajo.",
  "one or more action webhook endpoint ids are invalid":
    "Uno o más ID de endpoint de webhook de la acción no son válidos.",
  "one or more card ids are not in this board":
    "Uno o más ID de tarjeta no están en este tablero.",
  "one or more cards were not found on this board":
    "No se encontraron una o más tarjetas en este tablero.",
  "one or more checklist item ids do not match the supplied board, card, or checklist":
    "Uno o más ID de elementos de la lista no coinciden con el tablero, la tarjeta o la lista de verificación indicados.",
  "one or more checklists were not found on their cards":
    "No se encontraron una o más listas de verificación en sus tarjetas.",
  "one or more label ids are invalid":
    "Uno o más ID de etiqueta no son válidos.",
  "one or more set custom field ids are invalid":
    "Uno o más ID de campo personalizado que se van a establecer no son válidos.",
  "one or more source lists are not in the source workspace":
    "Una o más listas de origen no están en el espacio de trabajo de origen.",
  "one or more target lists are not in the target workspace":
    "Una o más listas de destino no están en el espacio de trabajo de destino.",
  "one or more trigger user ids are not assignable workspace members":
    "Uno o más ID de usuario del activador no son miembros asignables del espacio de trabajo.",
  "one or more user ids are not assignable members":
    "Uno o más ID de usuario no son miembros asignables.",
  "only an owner can change owner roles":
    "Solo un propietario puede cambiar los roles de propietario.",
  "only an owner can remove an owner":
    "Solo un propietario puede quitar a otro propietario.",
  "only failed deliveries can be retried":
    "Solo se pueden reintentar los envíos fallidos.",
  "only failed emails can be retried":
    "Solo se pueden reintentar los correos fallidos.",
  "only failed push notifications can be retried":
    "Solo se pueden reintentar las notificaciones push fallidas.",
  "only failed webhook deliveries can be retried":
    "Solo se pueden reintentar los envíos de webhook fallidos.",
  "only pending emails can be cancelled":
    "Solo se pueden cancelar los correos pendientes.",
  "only pending outbox events can be cancelled":
    "Solo se pueden cancelar los eventos pendientes de la bandeja de salida.",
  "only pending outbox events can be retried":
    "Solo se pueden reintentar los eventos pendientes de la bandeja de salida.",
  "only pending push notifications can be cancelled":
    "Solo se pueden cancelar las notificaciones push pendientes.",
  "only pending webhook deliveries can be cancelled":
    "Solo se pueden cancelar los envíos de webhook pendientes.",
  "only user sessions can create an organisation":
    "Solo las sesiones de usuario pueden crear una organización.",
  "only user sessions can delete an organisation":
    "Solo las sesiones de usuario pueden eliminar una organización.",
  "option not found":
    "No se encontró la opción.",
  "options are only valid for select fields":
    "Las opciones solo son válidas para campos de selección.",
  "organisation is unavailable for billing":
    "La organización no está disponible para la facturación.",
  "organisation membership is not active":
    "La membresía de la organización no está activa.",
  "organisation membership not found":
    "No se encontró la membresía de la organización.",
  "organisation name does not match":
    "El nombre de la organización no coincide.",
  "organisation not found":
    "No se encontró la organización.",
  "organisation owners and admins already inherit standalone board access":
    "Los propietarios y administradores de la organización ya heredan el acceso a los tableros independientes.",
  "organisation owners and admins are always workspace admins":
    "Los propietarios y administradores de la organización son siempre administradores del espacio de trabajo.",
  "organisation owners and admins cannot be removed from a workspace":
    "Los propietarios y administradores de la organización no se pueden quitar de un espacio de trabajo.",
  "outbox event not found":
    "No se encontró el evento de la bandeja de salida.",
  "paid plans require trialing, active, or past_due billing status":
    "Los planes de pago requieren un estado de facturación trialing, active o past_due.",
  "parent note in different scope":
    "La nota principal está en otro ámbito.",
  "parent note not found":
    "No se encontró la nota principal.",
  "parentItemId must identify a top-level item on this card":
    "parentItemId debe identificar un elemento de primer nivel de esta tarjeta.",
  "pending invitation not found":
    "No se encontró la invitación pendiente.",
  "plan changes are only available in hosted mode":
    "Los cambios de plan solo están disponibles en el modo alojado.",
  "priority anchor is not visible":
    "El anclaje de prioridad no está visible.",
  "priority field must be an active select or text field in this workspace":
    "El campo de prioridad debe ser un campo de selección o de texto activo de este espacio de trabajo.",
  "provide ids to add or remove":
    "Indica los ID que quieres añadir o quitar.",
  "public board card reads require listId and cardLimit; use includeCards=false for board metadata":
    "Las lecturas de tarjetas de tableros públicos requieren listId y cardLimit. Usa includeCards=false para obtener los metadatos del tablero.",
  "push messaging is managed by the hosted deployment":
    "La mensajería push la gestiona el despliegue alojado.",
  "push notification not found":
    "No se encontró la notificación push.",
  "rate limit exceeded":
    "Has superado el límite de solicitudes.",
  "redirect URIs must use HTTPS, except localhost callbacks":
    "Las URI de redirección deben usar HTTPS, salvo las de localhost.",
  "redirect_uri is not registered":
    "redirect_uri no está registrada.",
  "refresh token client mismatch":
    "El token de actualización no corresponde a este cliente.",
  "refresh token reuse or expiry detected":
    "Se detectó la reutilización o caducidad del token de actualización.",
  "refresh_token is not allowed for this client":
    "refresh_token no está permitido para este cliente.",
  "refresh_token is required":
    "Se requiere refresh_token.",
  "remindAt must be in the future":
    "remindAt debe estar en el futuro.",
  "requested scope exceeds the service connection maximum":
    "El ámbito solicitado supera el máximo de la conexión de servicio.",
  "resource is required":
    "Se requiere resource.",
  "scratchpad page has changed since it was read":
    "La página del bloc de notas cambió desde que se leyó.",
  "secretAccessKey required":
    "Se requiere secretAccessKey.",
  "security challenge failed":
    "La verificación de seguridad falló.",
  "security challenge required":
    "Se requiere una verificación de seguridad.",
  "set custom field copy source is invalid":
    "El origen de copia del campo personalizado no es válido.",
  "set custom field value does not match field type":
    "El valor del campo personalizado no coincide con el tipo de campo.",
  "share target must be an active user in your organisation":
    "El destinatario debe ser un usuario activo de tu organización.",
  "since must be a cursor returned by a previous call":
    "since debe ser un cursor devuelto por una llamada anterior.",
  "smtp is configured by environment variables":
    "SMTP se configura mediante variables de entorno.",
  "smtp is configured by the hosted deployment":
    "SMTP lo configura el despliegue alojado.",
  "smtp password required":
    "Se requiere la contraseña de SMTP.",
  "smtpConfig required":
    "Se requiere smtpConfig.",
  "source lists must be unique":
    "Las listas de origen deben ser únicas.",
  "standalone board configuration must contain exactly one board":
    "La configuración de un tablero independiente debe contener exactamente un tablero.",
  "standalone board import target not found":
    "No se encontró el destino de importación del tablero independiente.",
  "standalone boards cannot contain another board":
    "Los tableros independientes no pueden contener otro tablero.",
  "start dates and the timeline are disabled for this workspace":
    "Las fechas de inicio y el cronograma están desactivados en este espacio de trabajo.",
  "storage is configured by environment variables":
    "El almacenamiento se configura mediante variables de entorno.",
  "storage is configured by the hosted deployment":
    "El almacenamiento lo configura el despliegue alojado.",
  "storageConfig required":
    "Se requiere storageConfig.",
  "subscription limit reached":
    "Se alcanzó el límite de suscripciones.",
  "subscription not found":
    "No se encontró la suscripción.",
  "superadmin required":
    "Se requiere un superadministrador.",
  "support session not found":
    "No se encontró la sesión de soporte.",
  "switch organisation to access this resource":
    "Cambia de organización para acceder a este recurso.",
  "target board must be in the same workspace":
    "El tablero de destino debe estar en el mismo espacio de trabajo.",
  "target board must differ from current board":
    "El tablero de destino debe ser distinto del tablero actual.",
  "target checklist must have the same parent item":
    "La lista de verificación de destino debe tener el mismo elemento principal.",
  "target checklist not on this card":
    "La lista de verificación de destino no está en esta tarjeta.",
  "target is not a removable board guest":
    "El destino no es un invitado del tablero que se pueda quitar.",
  "target list not in board workspace":
    "La lista de destino no está en el espacio de trabajo del tablero.",
  "target list not in same workspace":
    "La lista de destino no está en el mismo espacio de trabajo.",
  "target list not in workspace":
    "La lista de destino no está en el espacio de trabajo.",
  "target list required":
    "Se requiere una lista de destino.",
  "target org not found or has no active owner to act as":
    "No se encontró la organización de destino o no tiene un propietario activo en cuyo nombre actuar.",
  "target user not found":
    "No se encontró el usuario de destino.",
  "targetListId is required for cross-workspace mirrors":
    "Se requiere targetListId para los espejos entre espacios de trabajo.",
  "targetListId must differ from source list":
    "targetListId debe ser distinto de la lista de origen.",
  "telegram requires a bot token and chat id":
    "Telegram requiere un token de bot y un ID de chat.",
  "that is already your email address":
    "Esa ya es tu dirección de correo electrónico.",
  "the credential that created this upload link is no longer valid":
    "La credencial que creó este enlace de subida ya no es válida.",
  "the final active superadmin cannot be disabled":
    "No se puede desactivar al último superadministrador activo.",
  "the mirror provider namespace is reserved":
    "El espacio de nombres del proveedor de espejos está reservado.",
  "the notification inbox needs a personal API key or OAuth connection":
    "La bandeja de notificaciones requiere una clave de API personal o una conexión OAuth.",
  "the owner already has access":
    "El propietario ya tiene acceso.",
  "the scratchpad needs a personal API key or OAuth connection":
    "El bloc de notas requiere una clave de API personal o una conexión OAuth.",
  "this GitHub installation is not accessible to the authorizing GitHub user":
    "Esta instalación de GitHub no es accesible para el usuario de GitHub que autoriza.",
  "this board mirror already exists":
    "Este espejo del tablero ya existe.",
  "this guest must subscribe to an assigned card":
    "Este invitado debe seguir una tarjeta asignada.",
  "this invitation was sent to a different email address":
    "Esta invitación se envió a otra dirección de correo electrónico.",
  "time in progress is disabled for this workspace":
    "El tiempo en curso está desactivado en este espacio de trabajo.",
  "too many attempts; request a new code":
    "Demasiados intentos. Solicita un código nuevo.",
  "triggerCustomFieldId and triggerCustomFieldValue are required":
    "Se requieren triggerCustomFieldId y triggerCustomFieldValue.",
  "triggerDaysBefore is required":
    "Se requiere triggerDaysBefore.",
  "in-progress limit field must be a number field":
    "El campo del límite de tiempo en curso debe ser un campo numérico.",
  "triggerCustomFieldId is required":
    "Se requiere triggerCustomFieldId.",
  "triggerThresholdAmount is required":
    "Se requiere triggerThresholdAmount.",
  "triggerThresholdUnit is required":
    "Se requiere triggerThresholdUnit.",
  "triggerLabelId is required":
    "Se requiere triggerLabelId.",
  "triggerListId is required":
    "Se requiere triggerListId.",
  "triggerUserIds is required":
    "Se requiere triggerUserIds.",
  "unknown event":
    "Evento desconocido.",
  "unknown option for custom field trigger":
    "Opción desconocida para el activador del campo personalizado.",
  "unknown option for set custom field action":
    "Opción desconocida para la acción de establecer el campo personalizado.",
  "unknown option for this field":
    "Opción desconocida para este campo.",
  "unknown or revoked OAuth client":
    "El cliente OAuth es desconocido o se revocó.",
  "unsubscribe link is invalid":
    "El enlace para cancelar la suscripción no es válido.",
  "unsupported OAuth resource":
    "Recurso OAuth no admitido.",
  "unsupported OAuth scope":
    "Ámbito OAuth no admitido.",
  "unsupported delivery mode":
    "Modo de entrega no admitido.",
  "unsupported file type":
    "Tipo de archivo no admitido.",
  "unsupported file type; pass a supported mimeType or a file name with a supported extension":
    "Tipo de archivo no admitido. Indica un mimeType admitido o un nombre de archivo con una extensión admitida.",
  "unsupported grant_type":
    "grant_type no admitido.",
  "upload a CSV file":
    "Sube un archivo CSV.",
  "upload a Kanera board JSON export":
    "Sube una exportación JSON de un tablero de Kanera.",
  "upload a Trello JSON export":
    "Sube una exportación JSON de Trello.",
  "upload body is empty":
    "El cuerpo de la subida está vacío.",
  "upload link is invalid, expired, or already used; create a new one":
    "El enlace de subida no es válido, ha caducado o ya se usó. Crea uno nuevo.",
  "use /billing/checkout to start a Stripe checkout session":
    "Usa /billing/checkout para iniciar una sesión de pago de Stripe.",
  "use /billing/portal to manage or cancel a Stripe subscription":
    "Usa /billing/portal para gestionar o cancelar una suscripción de Stripe.",
  "use add/remove for multi-value fields":
    "Usa add/remove para los campos de varios valores.",
  "use the leave organisation action to remove yourself":
    "Usa la acción de abandonar la organización para quitarte a ti mismo.",
  "user is already a board member":
    "El usuario ya es miembro del tablero.",
  "user is already a workspace member":
    "El usuario ya es miembro del espacio de trabajo.",
  "user is not a workspace member":
    "El usuario no es miembro del espacio de trabajo.",
  "user is not visible in the selected work scope":
    "El usuario no es visible en el ámbito de trabajo seleccionado.",
  "user not found":
    "No se encontró el usuario.",
  "users already associated with this organisation cannot accept board guest invites":
    "Los usuarios que ya están asociados a esta organización no pueden aceptar invitaciones como invitados de un tablero.",
  "users already in this organisation cannot accept board guest invites":
    "Los usuarios que ya están en esta organización no pueden aceptar invitaciones como invitados de un tablero.",
  "variant must be original, cover, or thumbnail":
    "variant debe ser original, cover o thumbnail.",
  "verification code required":
    "Se requiere el código de verificación.",
  "webhook not found":
    "No se encontró el webhook.",
  "webhook requires a URL and signing secret":
    "El webhook requiere una URL y un secreto de firma.",
  "webhook url host is not allowed":
    "El host de la URL del webhook no está permitido.",
  "webhook url host resolves to a blocked address":
    "El host de la URL del webhook se resuelve en una dirección bloqueada.",
  "webhook url must use http(s)":
    "La URL del webhook debe usar http(s).",
  "webhook url must use https":
    "La URL del webhook debe usar https.",
  "work view not found":
    "No se encontró la vista de trabajo.",
  "work-done day cannot be in the future":
    "El día de trabajo realizado no puede estar en el futuro.",
  "work-history cursor does not match this query":
    "El cursor del historial de trabajo no corresponde a esta consulta.",
  "workspace name does not match":
    "El nombre del espacio de trabajo no coincide.",
  "workspace not found":
    "No se encontró el espacio de trabajo.",
  "workspace not in your organisation":
    "El espacio de trabajo no está en tu organización.",
  "write-capable credential required":
    "Se requiere una credencial con permisos de escritura.",
  "you are already a member of this organisation":
    "Ya eres miembro de esta organización.",
  "you cannot disable your own account":
    "No puedes desactivar tu propia cuenta.",
  "you cannot reset your own MFA":
    "No puedes restablecer tu propia MFA.",
  "your membership of this organisation is suspended":
    "Tu membresía en esta organización está suspendida.",
  "validation failed":
    "La validación falló.",
  "internal error":
    "Se produjo un error interno.",
  "forbidden":
    "No tienes permiso para hacer esto.",
  "not found":
    "No se encontró.",
  "conflict":
    "Se produjo un conflicto.",
  "bad request":
    "Solicitud no válida.",
  "unauthorized":
    "No autorizado.",
  "web push is not configured":
    "Las notificaciones push web no están configuradas.",
  "push messages are disabled for this organisation":
    "Los mensajes push están desactivados para esta organización.",
  "provide dueDateLocalDate when setting dueDateSlot":
    "Indica dueDateLocalDate al establecer dueDateSlot.",
  "cannot leave as the last owner":
    "No puedes salir siendo el último propietario.",
  "cannot remove the last owner":
    "No se puede quitar al último propietario.",
  "notification destination url must use http(s)":
    "La URL del destino de notificaciones debe usar http(s).",
  "notification destination url must use https":
    "La URL del destino de notificaciones debe usar https.",
  "invalid authorization code":
    "El código de autorización no es válido.",
  "authorization grant is revoked":
    "La concesión de autorización se revocó.",
  "Request body is too large":
    "El cuerpo de la solicitud es demasiado grande.",
  "Unsupported Media Type":
    "Tipo de contenido no admitido.",
  "Request body size did not match Content-Length":
    "El tamaño del cuerpo de la solicitud no coincide con Content-Length.",
  "Body cannot be empty when content-type is set to 'application/json'":
    "El cuerpo no puede estar vacío cuando content-type es 'application/json'.",
  "Body is not valid JSON but content-type is set to 'application/json'":
    "El cuerpo no es JSON válido, pero content-type es 'application/json'.",
  "Your plan's boards limit has been reached. Upgrade to add more.":
    "Se alcanzó el límite de tableros de tu plan. Mejora tu plan para añadir más.",
  "Your plan's members limit has been reached. Upgrade to add more.":
    "Se alcanzó el límite de miembros de tu plan. Mejora tu plan para añadir más.",
  "Your plan's enabled automations limit has been reached. Upgrade to add more.":
    "Se alcanzó el límite de automatizaciones activas de tu plan. Mejora tu plan para añadir más.",
  "This organisation is on the Free plan, which allows your AI agents and API keys {limit} requests per second on its boards, and the request queue is full. Retry shortly; Kanera Pro raises these limits.":
    "Esta organización tiene el plan Free, que permite a tus agentes de IA y claves de API {limit} solicitudes por segundo en sus tableros, y la cola de solicitudes está llena. Vuelve a intentarlo en breve; Kanera Pro aumenta estos límites.",
  "This organisation is on the Free plan, which allows your AI agents and API keys {limit} requests per minute on its boards. Retry shortly; Kanera Pro raises these limits.":
    "Esta organización tiene el plan Free, que permite a tus agentes de IA y claves de API {limit} solicitudes por minuto en sus tableros. Vuelve a intentarlo en breve; Kanera Pro aumenta estos límites.",
  "{field} not found":
    "No se encontró {field}.",
  "{type} anchor not found":
    "No se encontró el anclaje {type}.",
  "{provider} requires a webhook url":
    "{provider} requiere una URL de webhook.",
  "CSV column {column} does not exist":
    "La columna {column} del CSV no existe.",
  "CSV exceeds the {max} column limit":
    "El CSV supera el límite de {max} columnas.",
  "CSV exceeds the {max} row limit":
    "El CSV supera el límite de {max} filas.",
  "File is too large. The maximum file size is {size}.":
    "El archivo es demasiado grande. El tamaño máximo de archivo es {size}.",
  "Workspaces can have up to {max} automations. Contact support if you need more.":
    "Los espacios de trabajo pueden tener hasta {max} automatizaciones. Ponte en contacto con soporte si necesitas más.",
  "Your organisation has used its {quota} storage allowance. Upgrade the plan or remove files to upload more.":
    "Tu organización ha usado sus {quota} de almacenamiento. Mejora el plan o elimina archivos para subir más.",
  "a priority queue holds at most {max} cards":
    "Una cola de prioridades admite como máximo {max} tarjetas.",
  "a scratchpad holds at most {max} pages":
    "Un bloc de notas admite como máximo {max} páginas.",
  "a scratchpad holds at most {max} pages; capture to an existing page title":
    "Un bloc de notas admite como máximo {max} páginas. Captura en el título de una página existente.",
  "automation action checklist template not found: {name}":
    "No se encontró la plantilla de lista de verificación de la acción de automatización: {name}",
  "automation action custom field not found: {name}":
    "No se encontró el campo personalizado de la acción de automatización: {name}",
  "automation action custom field option not found: {name}":
    "No se encontró la opción del campo personalizado de la acción de automatización: {name}",
  "automation action label not found: {name}":
    "No se encontró la etiqueta de la acción de automatización: {name}",
  "automation action list not found: {name}":
    "No se encontró la lista de la acción de automatización: {name}",
  "automation trigger label not found: {name}":
    "No se encontró la etiqueta del activador de automatización: {name}",
  "automation trigger list not found: {name}":
    "No se encontró la lista del activador de automatización: {name}",
  "starter card checklist template not found: {name}":
    "No se encontró la plantilla de lista de verificación de la tarjeta inicial: {name}",
  "starter card label not found: {name}":
    "No se encontró la etiqueta de la tarjeta inicial: {name}",
  "starter card list not found: {name}":
    "No se encontró la lista de la tarjeta inicial: {name}",
  "bulk delete only removes comments you authored; not authored by you: {ids}":
    "La eliminación masiva solo quita los comentarios que escribiste tú. No son tuyos: {ids}",
  "cannot delete the last owner of {orgName}":
    "No se puede eliminar al último propietario de {orgName}.",
  "cards[{index}]: {message}":
    "cards[{index}]: {message}",
  "comments not found on this board: {ids}":
    "No se encontraron estos comentarios en este tablero: {ids}",
  "could not parse CSV: {reason}":
    "No se pudo analizar el CSV: {reason}",
  "could not parse Kanera JSON: {reason}":
    "No se pudo analizar el JSON de Kanera: {reason}",
  "could not parse Trello JSON: {reason}":
    "No se pudo analizar el JSON de Trello: {reason}",
  "expected {type} value":
    "Se esperaba un valor de tipo {type}.",
  "invalid {provider} credentials":
    "Las credenciales de {provider} no son válidas.",
  "remindAt must be within {days} days":
    "remindAt debe estar dentro de los próximos {days} días.",
  "this attachment has no {variant} image":
    "Este archivo adjunto no tiene una imagen {variant}.",
  "work-done history is limited to the last {days} days":
    "El historial de trabajo realizado se limita a los últimos {days} días.",
  "a card cannot be related to itself": "Una tarjeta no puede relacionarse consigo misma.",
  "a completed card cannot block another card": "Una tarjeta completada no puede bloquear otra tarjeta.",
  "cards must be in the same workspace to be related": "Las tarjetas deben estar en el mismo espacio de trabajo para relacionarse.",
  "relation not found": "No se encontró la relación.",
  "this relation would create a blocking cycle": "Esta relación crearía un ciclo de bloqueo.",
};
