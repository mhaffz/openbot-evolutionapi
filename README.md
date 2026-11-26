# Evolution API → OpenBot por fila local

Este bridge contorna a indisponibilidade do endpoint público de webhook do OpenBot. A Evolution envia `MESSAGES_UPSERT` para a VPS; o bridge valida o JWT e grava o evento numa fila criptografada. Um worker no computador do OpenBot busca a fila e inicia a rotina localmente pela API `Local scripts`. O bridge deixa de encaminhar eventos ao Signal.

## Fluxo

1. Evolution envia o evento para `POST /evolution`.
2. O bridge valida o JWT HS256, a instância e o tipo do evento; remove campos secretos e conteúdo Base64.
3. O evento é criptografado com AES-256-GCM e guardado no volume persistente da VPS. A chave é derivada do segredo já compartilhado, sem uma nova variável secreta.
4. O worker local busca o evento por HTTPS e chama `POST /v1/agents/{agentId}/routines/{routineId}/run` no listener local do OpenBot.
5. Depois de o OpenBot aceitar a execução, o worker confirma a mensagem da fila. Mensagens próprias, grupos e status são descartados localmente.

O endpoint de automação local não inicia diretamente uma rotina do tipo Webhook. Por isso, foi criada no agente Vendas a rotina auxiliar **Atendimento WhatsApp Evolution API — Fila Local**, pausada e com execução única futura. O worker a inicia sob demanda pela API local; ela não roda pelo agendamento.

O bridge não grava o conteúdo do evento nos logs. Os arquivos da fila são criptografados, removidos após confirmação ou depois de 24 horas, e limitados a 2.000 eventos. O conteúdo pode permanecer temporariamente no volume da VPS até o worker processá-lo.

## Requisitos

- A instância da Evolution `Paut` e a aplicação Coolify continuam como estão, usando o mesmo domínio e a rota `/evolution`.
- `WEBHOOK_SHARED_SECRET` no Coolify continua com o mesmo valor da configuração de `jwt_key` da Evolution e da chave de assinatura da rotina.
- A rotina `Atendimento WhatsApp Evolution API` continua ativa e filtrando `MESSAGES_UPSERT`.
- **Local scripts** precisa estar habilitado para Vendas no OpenBot. O OpenBot deve estar aberto na conta que contém o agente e a rotina.
- O computador deve permanecer ligado e conectado à internet para processar a fila. Se ficar offline, as mensagens acumulam na VPS até voltar, por no máximo 24 horas.

## Deploy da VPS pelo Coolify

Atualize a aplicação a partir deste código mantendo o domínio e a porta interna `8080`. Preserve a variável `WEBHOOK_SHARED_SECRET` sem exibi-la, e mantenha `EVOLUTION_INSTANCE_NAME=Paut`. O Compose cria o volume persistente `evolution_queue` para a fila e os recibos.

Confira `GET /health`; a resposta informa `status: ok` e a quantidade de eventos pendentes. O endpoint `/` continuará respondendo `not_found`, o que é esperado.

## Worker Windows

Copie `worker.ps1` e `install-worker.ps1` para uma pasta estável no mesmo computador e sob o mesmo usuário Windows que executa o OpenBot. Revise `BridgeBaseUrl`, `agentId` e o ID da rotina auxiliar no início de `worker.ps1` se o ambiente ou a rotina mudar. Execute `install-worker.ps1` no PowerShell do usuário. Ele cria uma tarefa no Agendador para iniciar o worker no logon e inicia a tarefa na hora.

O worker lê o token local de `%APPDATA%\OpenBot\automation` e a chave já salva no cofre do OpenBot. Não há token ou segredo no script. O log fica em `%APPDATA%\OpenBot\logs\evolution-local-queue-worker.log` e contém apenas status e IDs hash, nunca o texto, telefone ou JID.

## Verificação

1. Confirme que `/health` responde `status: ok`.
2. Confirme que a tarefa `OpenBot Evolution Local Queue Worker` está em execução.
3. Envie uma mensagem de texto de um número de teste autorizado para o WhatsApp conectado.
4. Confira que a fila volta a zero, que a rotina registra a execução e que a resposta chega ao remetente de teste.

Não use mensagens de clientes para o teste. Uma entrega aceita pela fila confirma recebimento, não a conclusão da resposta. Em uma queda abrupta entre a execução local aceita e a confirmação da fila, pode haver uma repetição; a rotina deve preservar sua regra de ignorar mensagens próprias para evitar resposta em loop.

## Autenticação da fila

O worker e o bridge derivam um token de fila por HMAC-SHA256 do segredo já compartilhado, com o contexto `openbot-evolution-local-queue-v1`. O segredo não é enviado ao endpoint de polling. O bridge oferece:

- `GET /queue/next`: entrega o evento pendente mais antigo;
- `POST /queue/ack` com `{"id":"evo-<sha256>"}`: confirma após o OpenBot aceitar a execução;
- `GET /health`: estado e tamanho da fila, sem dados pessoais.
