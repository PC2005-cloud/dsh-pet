/**
 * 设置页葡萄牙语文案；键集与 zh 完全一致。
 */
import type { Key } from './zh.ts';

export const pt: Record<Key, string> = {
  nav: 'Configuração do pet',
  intro: 'Gerencie vários pets: cada um tem tamanho e posição próprios (aplicado na hora após salvar).',
  // 卡片标题与卡片级说明；说明统一进问号气泡。
  petCardTitle: 'Pet',
  petCardHint:
    'Ajustes por pet: nome / tamanho / exibição / posição / deslocamentos / os quatro interruptores. Clique em "Salvar" no fim para aplicar na hora.',
  globalTitle: 'Interruptores globais',
  globalHint:
    'Compartilhados por todos os pets (um pet pack pode sobrescrevê-los no arquivo do próprio tipo). Estes interruptores só mudam o estado local e são gravados na configuração do usuário ao "Salvar" (nunca na hora); as notificações do sistema são relidas logo após salvar, sem recarregar a página.',
  cornerHint: 'Em qual canto da tela o pet fica (no desktop, conforme a área de trabalho de cada monitor).',
  marginXHint: 'Distância horizontal até o canto escolhido (px); qualquer número.',
  marginYHint: 'Distância vertical até o canto escolhido (px); qualquer número.',
  // 「/」命令菜单的行标题（图标由 app.ts 经 command-faces.ts 补上）。
  'cmd.chat': 'Conversa',
  'cmd.pet': 'Pet',
  'cmd.balance': 'Saldo',
  'shortcut.open': 'Abrir o chat do pet',
  'shortcut.chat': 'Abrir a janela de chat',
  'shortcut.hear': 'Entrada de voz',
  shortcutCardTitle: 'Atalhos',
  shortcutCardHint: 'A primeira tecla só vale com o ponteiro sobre o pet; as com Ctrl são globais.',
  shortcutRowChat: 'Abrir chat',
  shortcutRowHear: 'Entrada de voz',
  shortcutRowTodo: 'Tarefas',
  shortcutRowSleep: 'Dormir / acordar',
  shortcutRowSidebar: 'Abrir chat lateral',
  shortcutNoteDesktop:
    'Os atalhos globais não valem para a janela do desktop; podem ser alterados em Configurações → Geral → Atalhos.',
  petsLabel: 'Pets',
  add: 'Adicionar pet',
  remove: 'Remover',
  confirmRemove: 'Excluir o pet "{id}"?',
  confirmTitle: 'Confirmar ação',
  cancel: 'Cancelar',
  ok: 'Entendi',
  atLeastOne: 'Mantenha pelo menos um pet.',
  emptyPets: 'Nenhum pet ainda — clique em "Adicionar pet" para criar.',
  sizeLabel: 'Tamanho (largura px)',
  sizeHint: 'A altura é automática = largura × 9/16.',
  sizePercentLabel: 'Largura máx. da tela (%)',
  sizePercentHint:
    'Quanto da largura da tela o pet pode ocupar: 100 = nunca mais largo que uma tela (igual ao px em janelas largas); 30–40 deixa bem menor no celular sem mudar o desktop. Calculado uma vez ao carregar; recarregue após redimensionar.',
  nameLabel: 'Nome',
  nameHint:
    'Nome exibido ao passar o mouse e incluído na persona da IA ("seu nome é X"). Pode repetir; vazio usa o id do pet.',
  personaLabel: 'Persona (opcional)',
  personaHint:
    'Vale só para este pet. Vazio = segue a persona da entrada — o texto cinza na caixa é exatamente isso. O system enviado ao modelo = este texto + uma linha "seu nome é <nome>" anexada automaticamente + o contexto de hora atual, então não repita o nome nem a data aqui.',
  personaCount: '{n} caracteres',
  balanceEnabled: 'Saldo',
  balanceEnabledHint: 'Quando ativado, este pet toca as animações de saldo e mostra o balão de saldo.',
  whisperEnabled: 'Sussurro',
  whisperEnabledHint:
    'Quando ativado, este pet gera uma frase com IA periodicamente e toca a animação de sussurro (persona = o campo abaixo; vazio segue a entrada).',
  workStatusEnabled: 'Status de trabalho',
  workStatusEnabledHint:
    'Quando ativado, este pet segue o estado de trabalho do DSH: pensando / trabalhando / aguardando confirmação / concluído / erro trocam a animação e mostram balões (o pool fica na configuração de topo; apenas escuta, sem chamar o modelo).',
  fixedEnabled: 'Fixar no lugar',
  fixedEnabledHint:
    'Quando ativado, a cadeia aleatória não gira nem afasta mais este pet — só tocam as ações de espera no lugar. Escolhas pelo menu de contexto, gatilhos da API e animações de saldo / sussurro / status de trabalho não são afetadas.',
  displayLabel: 'Exibição',
  displayHint: 'web = só no navegador / desktop = só no desktop / both = nos dois / none = em nenhum',
  'display.web': 'Só no navegador',
  'display.desktop': 'Só no desktop',
  'display.both': 'Nos dois',
  'display.none': 'Em nenhum',
  cornerLabel: 'Posição',
  'corner.top-left': 'Canto superior esquerdo',
  'corner.top-right': 'Canto superior direito',
  'corner.bottom-left': 'Canto inferior esquerdo',
  'corner.bottom-right': 'Canto inferior direito',
  marginX: 'Deslocamento horizontal',
  marginY: 'Deslocamento vertical',
  save: 'Salvar',
  saveHotkey: 'Ctrl+S / Cmd+S',
  sync: 'Sincronizar',
  confirmSync:
    'Sincronizar? Isso sobrescreve a configuração do usuário com a configuração padrão incluída no projeto (todos os campos + comentários); as personalizações atuais serão perdidas.',
  corruptTitle: 'A configuração do usuário está corrompida — não salva',
  corruptConfirm: 'Salvar mesmo assim',
  corruptBody:
    'Não foi possível ler a configuração do usuário (conteúdo corrompido, não é JSON/JSONC válido): {path}. Salvar agora recria o arquivo a partir da lista branca — tudo o que está nele hoje (animações / física / memes etc.) será perdido. Cancelar = não mexe no arquivo (corrija e salve de novo); Confirmar = salva mesmo assim (descarta o conteúdo atual do arquivo).',
  syncHint:
    '"Sincronizar" grava a configuração padrão incluída no projeto (com comentários e todos os campos avançados) no arquivo do usuário, sobrescrevendo suas personalizações; depois disso o arquivo já pode ser editado direto. Dois avisos: (1) uma vez criado, o arquivo é uma camada de sobrescrita explícita — mudanças nos padrões do projeto não passam a valer sozinhas (só sincronizando de novo ou apagando o arquivo); (2) clicar em "Salvar" nesta página reescreve o arquivo pela lista branca — os valores são mantidos, os comentários são removidos.',
  configMeta: 'Configuração avançada (arquivos)',
  configMetaHint:
    'A configuração do usuário pode sobrescrever a lista de pets / pools de animação / pesos — recarregue ou reinicie para aplicar: no navegador atualize a página, no desktop clique com o botão direito no pet → "Recarregar configuração" (recria todas as janelas de pet do desktop); a configuração padrão é a referência completa.',
  defaultConfig: 'Configuração padrão (somente leitura, referência completa)',
  userConfig: 'Configuração do usuário (sobrescritas personalizadas)',
  todosFile: 'Dados de tarefas (texto, prazo e estado de conclusão; apagar equivale a limpar tudo)',
  animationDir: 'Pasta de animações (adicione ou personalize animações aqui)',
  memesDir: 'Pasta de memes (adicione ou personalize imagens aqui)',
  logFile: 'Arquivo de log (para diagnóstico; pode ser limpo)',
  logFileNote:
    'O app desktop do DSH não tem console, então todo log de execução do plugin (inicialização, travamentos e reinícios do pet, erros e avisos) vai para este único arquivo — anexe-o ao relatar um problema. Limite de 1 MB por arquivo; ao encher, só os 512 KB mais recentes são mantidos.',
  saved: 'Salvo — os pets atualizaram na hora.',
  loadError: 'Falha ao carregar a configuração',
  saveError:
    'Falha ao salvar a configuração. Verifique a conexão com o servidor, a permissão de escrita na pasta de configuração e o log do servidor.',
  saveInvalid: 'Falha ao salvar a configuração: conteúdo inválido. Revise os valores e tente de novo.',
  syncError:
    'Falha ao sincronizar a configuração. Verifique a conexão com o servidor e a permissão de escrita na pasta de configuração.',
  loading: 'Carregando configuração…',
  retry: 'Tentar de novo',
  invalid: 'Revise os valores: o tamanho precisa ser positivo; as margens podem ser qualquer número.',
  busy: 'Salvando…',
  extraPetsHint:
    'Mais {n} tipo(s) vêm de arquivos na pasta pet/ (<nome>-config.json + <nome>-animation/). Troque para eles na linha "Tipos" acima; salvar grava no config de cada pacote, nunca no main-config.jsonc.',
  kindLabel: 'Tipos',
  kindMain: 'Embutido',
  lastOfKind:
    '"{entry}" tem só este pet — excluí-lo remove o tipo inteiro. Para remover de vez, apague os arquivos do pet pack.',
  savePartial:
    'Os pets principais foram salvos, mas {names} não pôde ser gravado: verifique se o config do pacote é válido e se a pasta permite escrita.',
  notifyToggle: 'Notificações do sistema',
  notifyToggleHint:
    'Avisos do sistema (canto inferior direito do desktop) para fim de conversa, falhas, pedidos de permissão e perguntas — só enquanto esta janela está sem foco.',
  clickSoundToggle: 'Som de clique',
  clickSoundToggleHint:
    'Toca o som de clique embutido (assets/sound/click-duck.wav, volume 0.5) quando o pet é clicado; cliques repetidos em até 100ms tocam uma vez só, então vários pets não empilham som. Desligue para silêncio total. Gravado na configuração do usuário junto com o "Salvar".',
  whisperImageToggle: 'Imagens no sussurro',
  whisperImageToggleHint:
    'Anexa um meme aleatório do pool a cada sussurro (o mapeamento de imagens fica no campo de topo memes). Tokens: o sussurro já chama o modelo a cada ciclo, então a imagem só acrescenta o nome + a descrição daquele meme (~100 caracteres / ~60 tokens) ao mesmo pedido — desprezível.',
  chatImageToggle: 'Imagens na conversa',
  chatImageToggleHint:
    'Deixa a IA escolher um meme do pool conforme o contexto atual (opcional; o mapeamento fica no campo de topo memes). Tokens: cada mensagem leva o catálogo inteiro — hoje ~1,1 mil caracteres (~650 tokens, cerca de 11x o caso do sussurro) e cresce com o número de imagens; desligado, não acrescenta nada.',
  chatAnimationToggle: 'Ações na conversa',
  chatAnimationToggleHint:
    'Quando ligado, o pedido de conversa leva a lista de animações que podem ser encenadas (todas as ações de animations.categories): se o modelo considerar que a frase realmente encena uma delas, o pet a executa na hora; caso contrário responde só com texto. Tokens: cada mensagem leva a lista inteira; desligado não acrescenta nada. Valor padrão global para todos os pets (um pet pack pode substituí-lo no próprio arquivo de configuração).',
  confineToggle: 'Fixar na tela atual',
  confineToggleHint:
    'Vários monitores: quando ligado, o pet fica dentro da tela em que está — um pet arremessado quica só na tela onde foi solto (as emendas entre telas viram paredes, ele não voa para a tela vizinha), e o passeio autônomo só anda dentro da tela atual (o passo que cruzaria a emenda é cancelado). Desligado, ele cruza telas normalmente. Só afeta o modo desktop — o overlay do navegador já fica dentro da viewport.',
  trayToggle: 'Bandeja do sistema',
  trayToggleHint:
    'Mostra um ícone na área de notificação (barra de menus no macOS) quando o modo desktop inicia. Ele lista todos os pets da configuração e alterna a exibição de cada um — inclusive os que estão fora do desktop agora e não têm janela para clicar com o botão direito. Sem ele, para trazer um pet de volta ao desktop é preciso abrir o navegador (a página de configuração, ou clicar com o botão direito no pet na web). O Windows já esconde ícones de terceiros na gaveta "ícones ocultos". Só afeta o modo desktop.',
  voiceTitle: 'Voz',
  voiceHint:
    'Três interruptores e uma voz: o mestre controla a fala automática; os dois secundários controlam um tipo de mensagem proativa cada. Tudo desligado por padrão; gravado na configuração do usuário ao "Salvar" (nunca na hora).',
  voiceEnabled: 'Falar respostas',
  voiceEnabledHint:
    'Interruptor mestre da fala automática. Desligado, sussurros periódicos e lembretes de tarefas ficam mudos (os dois secundários abaixo não têm efeito). Sussurro manual, respostas da conversa e o botão de alto-falante do painel de conversa não são afetados — você pediu, então a origem fala direto. Só decide se sai som: balões, memória da conversa e notificações do sistema não mudam; falha na síntese só gera log e nunca interrompe a conversa.',
  voiceWhisperEnabled: 'Falar sussurros',
  voiceWhisperEnabledHint:
    'Fala o sussurro gerado periodicamente (o sussurro manual pelo botão direito não é afetado). Dependente do interruptor mestre acima. Desligado por padrão — sussurros são narração de fundo e não devem fazer barulho sem pedir.',
  voiceTodoEnabled: 'Falar lembretes de tarefas',
  voiceTodoEnabledHint:
    'Fala o lembrete quando uma tarefa vence (o balão continua aparecendo; isto só decide se fala). Dependente do interruptor mestre acima. Desligado por padrão.',
  voiceNameLabel: 'Voz',
  physicsTitle: 'Física (sensação de arrastar e arremessar)',
  physicsHint:
    'Padrão global, compartilhado por todos os pets (um pet pack pode sobrescrever no arquivo do próprio tipo); gravado na configuração do usuário ao "Salvar" (nunca na hora). No navegador vale na hora; no desktop vale quando o "Salvar" recarrega as janelas do pet.',
  mobileTitle: 'Efeitos no celular',
  mobileHint:
    'Só fazem sentido no navegador do celular: a vibração precisa de motor, os dois interruptores de movimento precisam de sensores de inclinação/aceleração, e os sensores exigem HTTPS ou localhost.',
  'physics.gravity': 'Gravidade',
  'physics.gravityHint': 'px/s² — quanto maior, mais rápido cai; 0 = sem gravidade (voa em linha reta para sempre)',
  'physics.restitution': 'Restituição',
  'physics.restitutionHint':
    '0–1, velocidade mantida ao quicar na parede ou no chão (1 = totalmente elástico, 0 = para na hora)',
  'physics.groundFriction': 'Atrito de contato',
  'physics.groundFrictionHint':
    'por segundo, perda de velocidade ao longo de qualquer superfície (parede, chão, teto); 0 = gelo em todas',
  'physics.throwPower': 'Força de arremesso',
  'physics.throwPowerHint':
    '> 0, multiplicador geral da mola que segue o cursor e da velocidade de saída (1 = padrão; maior = mais colado ao cursor e arremessos mais fortes)',
  physicsCeilingBounce: 'Quicar no teto',
  physicsCeilingBounceHint:
    'Desligado, o arremesso pode sair pelo topo da tela (a gravidade ainda traz o pet de volta)',
  physicsPetCollision: 'Colisão entre pets',
  physicsPetCollisionHint: 'Um pet em voo quica nos outros com conservação de momento (massa ∝ tamanho²)',
  physicsHaptic: 'Vibração ao colidir',
  physicsHapticHint:
    'Uma vibração por impacto (paredes, chão, teto, outros pets). Funciona no Chrome/Edge; não no iOS nem em navegadores WebView como o Via. O modo Não perturbe bloqueia o vibrador.',
  physicsTilt: 'Gravidade por inclinação',
  physicsTiltHint:
    'Incline o celular e a gravidade acompanha (magnitude = o valor acima); com gravidade em 0 a inclinação não faz nada. Requer HTTPS/localhost.',
  physicsShake: 'Sacudir para arremessar',
  physicsShakeHint:
    'Sacuda para arremessar o pet na direção do gesto; a força acompanha o throwPower. Independe da gravidade, então funciona com gravidade 0. Requer HTTPS/localhost.',
  invalidPhysics:
    'Revise os valores de física: gravidade / atrito com o chão ≥ 0, restituição 0–1, força de arremesso > 0.',
  fontTitle: 'Aparência e fonte',
  fontHint:
    'A família vale para todo texto que hoje usa a fonte candy: balão do pet, dica ao passar o mouse, janela de conversa, popup de pontuação. O tamanho vale só para o balão do pet e a dica (as janelas de conversa e de pontuação mantêm o próprio tamanho). Padrão global, compartilhado por todos os pets (um pet pack pode sobrescrever no arquivo do próprio tipo); gravado na configuração do usuário ao "Salvar" — na hora no navegador, e no desktop quando o "Salvar" recarrega as janelas do pet.',
  fontFamilyLabel: 'Fonte',
  fontFamilyHint:
    '"Candy (embutida)" vem com o plugin; as demais são fontes do sistema. Se faltar na máquina, cai para a próxima da pilha (nunca fica em branco nem dá erro).',
  fontSizeLabel: 'Tamanho da fonte (px)',
  fontSizeHint:
    'Tamanho do texto do balão; a dica e as linhas menores dentro do balão escalam na proporção. Faixa 4–200.',
  fontFollowToggle: 'Escalar a fonte com o tamanho do pet',
  fontFollowToggleHint:
    'Ligado (padrão): a fonte cresce com o pet — com 462 px de largura fica exatamente no tamanho definido acima. Desligado: o tamanho fica fixo, independente do pet.',
  invalidFont:
    'Revise as configurações de fonte: a família precisa estar na lista e o tamanho precisa ser um número entre 4 e 200.',
  'font.candy': 'Candy (embutida)',
  'font.yahei': 'Microsoft YaHei / PingFang',
  'font.youyuan': 'YouYuan',
  'font.kaiti': 'KaiTi',
  'font.simsun': 'SimSun',
  'font.comic': 'Comic Sans MS',
  'font.system': 'Padrão do sistema',
  modelTitle: 'Conversa e modelos',
  modelHint:
    'Qual modelo o sussurro e a conversa usam, e quanta história cada pedido de conversa carrega. "Seguir a conversa atual" usa o modelo da conversa em que você está (padrão). Padrão global: vale para todos os pets, e um pet pack pode sobrescrever no arquivo do próprio tipo. As opções vêm da mesma fonte do seletor de modelos do DSH, servidas pelo host em tempo real.',
  modelFollow: 'Seguir a conversa atual',
  modelSearch: 'Buscar modelos…',
  modelEmpty: 'Nenhum modelo corresponde.',
  modelNoModels: 'Nenhum modelo disponível.',
  modelLoading: 'Atualizando a lista de modelos…',
  modelTriggerAria: 'Escolher modelo, atual {model}',
  modelUnknown: ' (configuração atual, fora da lista)',
  modelNone: 'Este provedor não tem modelos disponíveis',
  whisperModelLabel: 'Modelo do sussurro',
  chatModelLabel: 'Modelo da conversa',
  modelFieldHint:
    '"Seguir a conversa atual" usa o modelo da conversa; se um modelo escolhido falhar, o plugin volta ao modelo da conversa e tenta mais uma vez.',
  invalidModel:
    'Revise as configurações de modelo: escolha provedor e modelo, ou deixe os dois vazios (seguir a conversa atual).',
  modelCatalogFailed:
    'Falha ao carregar a lista de modelos (atualize a página para tentar de novo); os valores atuais são mantidos como estão.',
  chatMemory: 'Rodadas de histórico',
  chatMemoryHint:
    'Quantas rodadas recentes cada pedido de conversa carrega (1 rodada = 1 pergunta + 1 resposta; 0 = sem histórico, cada mensagem começa do zero). A memória em si guarda tudo — isto só decide quanto entra no contexto: mais memória, mais tokens. Padrão global, compartilhado por todos os pets (um pet pack pode sobrescrever no arquivo do próprio tipo).',
  invalidChatMemory: 'Revise as rodadas de histórico: precisa ser um número ≥ 0.',
  chatImageLimit: 'Limite de imagens na conversa',
  chatImageLimitHint:
    'Quantos memes no máximo são listados ao modelo na conversa ("primeiros N" = os N primeiros da configuração, então mova para o começo os que quer enviar). A lista inteira vai em cada mensagem e os tokens crescem linearmente com a quantidade, então lista longa é gasto puro; limitar aos N primeiros faz o modelo escolher só entre eles. 0 = sem limite (envia tudo). Padrão embutido 10. Padrão global, compartilhado por todos os pets (um pet pack pode sobrescrever no arquivo do próprio tipo). Só afeta a conversa — o sussurro leva só o meme sorteado.',
  invalidChatImageLimit: 'Revise o limite de imagens na conversa: precisa ser um número ≥ 0 (0 = sem limite).',
  notifyTest: 'Testar notificação',
  notifyTestOk: 'Notificação de teste enviada — veja o canto inferior direito do desktop.',
  notifyDenyUnsupported: 'Este ambiente não suporta notificações do sistema (sem API Notification no navegador).',
  notifyDenyBlocked: 'A permissão de notificação está marcada como bloqueada pelo navegador.',
  notifyDenyRejected: 'Você escolheu "Bloquear" na janela de permissão.',
  notifyDenyError: 'Erro ao pedir permissão',
  notifyGuide:
    'Como liberar: clique no 🔒/ⓘ ao lado da barra de endereços → "Configurações do site" → "Notificações" → mude para "Permitir", atualize a página e tente de novo.',
  storageTitle: 'Desinstalação e armazenamento',
  storageHint:
    'Todos os lugares em que o plugin grava arquivos. Apagar caches não atrapalha (são baixados ou recriados sozinhos); apagar "dados do usuário do plugin" perde a configuração e a memória da conversa.',
  'storage.userData':
    'Dados do usuário do plugin: configuração personalizada main-config.jsonc, memória da conversa memory.json, animações personalizadas main-animation/, pets de arquivo pet/',
  'storage.electron':
    'Runtime Electron usado pelo pet do desktop (grande; é baixado de novo automaticamente na próxima vez que o modo desktop iniciar)',
  'storage.desktopCache':
    'Cache das janelas do pet e cache de escala do monitor principal (pode apagar; é recriado sozinho)',
  'storage.electronCache':
    'Cache de download do instalador do Electron (pode apagar; é baixado de novo quando preciso)',
  'storage.package': 'O plugin em si (gerenciado pelo DSH — remova com o comando abaixo em vez de apagar na mão)',
  storageMissing: ' (ainda não criado)',
  uninstallTitle: 'Como desinstalar',
  uninstallStep1:
    '1. Feche o DSH primeiro (o pet do desktop fecha junto); não apague os arquivos acima com o pet em execução.',
  uninstallStep2: '2. Remova o plugin em si (no terminal; isto também o tira da camada de bundle do profile):',
  uninstallStep3:
    '3. Apague os locais acima conforme a necessidade: caches não fazem falta; apagar "dados do usuário do plugin" perde a configuração e a memória da conversa (faça backup do main-config.jsonc antes, se quiser manter).',
  uninstallCmd: 'dsh plugin --profile {profile} remove dsh-pet',
};
