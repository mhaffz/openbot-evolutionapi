# Ponte Evolution API → webhook do OpenBot

Este pequeno serviço valida o JWT HS256 que a Evolution envia em cada requisição e encaminha apenas eventos `MESSAGES_UPSERT`, no formato assinado exigido pela rotina de webhook do OpenBot. Ele não armazena o conteúdo das mensagens nem credenciais.

## Implantação no Coolify

Crie uma aplicação Docker Compose a partir desta pasta e atribua a ela um domínio com HTTPS. Defina as variáveis de ambiente abaixo no Coolify. Não as versione no repositório nem as cole em chats.

- `OPENBOT_WEBHOOK_URL`: URL do receptor retornada por `openbot.create_webhook_routine`.
- `WEBHOOK_SHARED_SECRET`: segredo de assinatura da rotina de webhook. Use o mesmo valor do `jwt_key` da Evolution, para que a ponte consiga verificar o JWT da Evolution e assinar a requisição encaminhada.

O serviço escuta na porta `8080`. O endpoint de saúde é `/health` e o caminho de callback da Evolution é `/evolution`.

## Configuração da instância na Evolution

Configure a instância `Paut` com `POST /webhook/set/Paut`, enviando a chave de API no cabeçalho `apikey`. No corpo da requisição:

- ative o webhook;
- defina a URL como `https://<dominio-da-ponte>/evolution`;
- defina `headers` como `{ "jwt_key": "<WEBHOOK_SHARED_SECRET>" }`;
- defina `webhookByEvents` como `false`;
- defina `webhookBase64` como `false`;
- habilite somente o evento `MESSAGES_UPSERT`.

Se a versão da Evolution implantada usar a rota `/event/webhook/set/{instance}`, use essa rota no lugar da anterior.

## Comportamento da rotina no OpenBot

A rotina ignora mensagens de grupos, de status e as enviadas pela própria conta conectada. Para as demais, ela usa a `EVOLUTION_GLOBAL_API_KEY` armazenada para enviar a resposta pelo endpoint `message/sendText` da Evolution.
