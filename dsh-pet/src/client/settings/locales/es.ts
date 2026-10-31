/**
 * 设置页西班牙语文案；键集与 zh 完全一致。
 */
import type { Key } from './zh.ts';

export const es: Record<Key, string> = {
  nav: 'Configuración de mascotas',
  intro:
    'Gestiona varias mascotas: cada una tiene su propio tamaño y posición (se aplica al instante después de guardar).',
  // 卡片标题与卡片级说明；说明统一进问号气泡。
  petCardTitle: 'Mascota',
  petCardHint:
    'Ajustes por mascota: nombre / tamaño / visualización / esquina / márgenes / los cuatro interruptores de funciones. Pulsa "Guardar" abajo para aplicar al instante.',
  globalTitle: 'Interruptores globales',
  globalHint:
    'Compartidos por todas las mascotas (un pet pack puede sobrescribirlos en el archivo de su propio tipo). Estos interruptores solo cambian el estado local y se escriben en la configuración del usuario al "Guardar" (nunca al instante); las notificaciones del sistema se vuelven a leer justo después de guardar, sin necesidad de recargar la página.',
  cornerHint:
    'En qué esquina de la pantalla se pega la mascota (en escritorio se calcula por el área de trabajo de cada monitor).',
  marginXHint: 'Distancia horizontal desde la esquina elegida (px); puede ser cualquier número.',
  marginYHint: 'Distancia vertical desde la esquina elegida (px); puede ser cualquier número.',
  // 「/」命令菜单的行标题（图标由 app.ts 经 command-faces.ts 补上）。
  'cmd.chat': 'Chat',
  'cmd.pet': 'Mascota',
  'cmd.balance': 'Saldo',
  'shortcut.open': 'Abrir el chat de la mascota',
  'shortcut.chat': 'Abrir la ventana de chat',
  'shortcut.hear': 'Entrada de voz',
  shortcutCardTitle: 'Atajos',
  shortcutCardHint: 'La primera tecla solo actúa con el puntero sobre la mascota; las de Ctrl son globales.',
  shortcutRowChat: 'Abrir chat',
  shortcutRowHear: 'Entrada de voz',
  shortcutRowTodo: 'Tareas',
  shortcutRowSleep: 'Dormir / despertar',
  shortcutRowSidebar: 'Abrir el chat lateral',
  shortcutNoteDesktop:
    'Los atajos globales no se aplican a la ventana del escritorio; se cambian en Ajustes → General → Atajos.',
  petsLabel: 'Mascotas',
  add: 'Agregar mascota',
  remove: 'Eliminar',
  confirmRemove: '¿Eliminar la mascota "{id}"?',
  confirmTitle: 'Confirmar acción',
  cancel: 'Cancelar',
  ok: 'Entendido',
  atLeastOne: 'Debe quedar al menos una mascota.',
  emptyPets: 'Aún no hay mascotas; haz clic en "Agregar mascota" para crear una.',
  sizeLabel: 'Tamaño (ancho px)',
  sizeHint: 'La altura es automática = ancho × 9/16.',
  sizePercentLabel: 'Ancho de pantalla máx. (%)',
  sizePercentHint:
    'Cuánto del ancho de pantalla puede ocupar la mascota: 100 = nunca más ancha que una pantalla (igual que px en ventanas anchas); 30–40 la hace claramente más pequeña en el móvil sin cambiar el escritorio. Se calcula una vez al cargar; recarga tras redimensionar.',
  nameLabel: 'Nombre',
  nameHint:
    'Se muestra al pasar el cursor y se añade a las personas de la IA ("tu nombre es X"). Se permiten duplicados; si se deja vacío, se usa el id de la mascota.',
  personaLabel: 'Persona (opcional)',
  personaHint:
    'Solo afecta a esta mascota. Déjalo vacío para seguir la persona de la entrada: el texto gris del cuadro es exactamente ese contenido. El system que se envía al modelo = este texto + una línea añadida con "tu nombre es <nombre>" + el contexto de la hora actual, así que no repitas aquí el nombre ni la fecha.',
  personaCount: '{n} caracteres',
  balanceEnabled: 'Saldo',
  balanceEnabledHint: 'Cuando está activado, esta mascota reproduce animaciones de saldo y muestra el globo de saldo.',
  whisperEnabled: 'Susurros',
  whisperEnabledHint:
    'Cuando está activado, esta mascota genera periódicamente una frase con IA y reproduce la animación de susurro (la persona está en el campo de abajo; vacío sigue la entrada).',
  workStatusEnabled: 'Estado de trabajo',
  workStatusEnabledHint:
    'Cuando está activado, esta mascota sigue el estado de trabajo de DSH: pensando / trabajando / esperando confirmación / terminado / error cambian la animación y muestran globos (el pool está en la configuración de nivel superior; solo escucha, no llama al modelo).',
  fixedEnabled: 'Fijar en el sitio',
  fixedEnabledHint:
    'Cuando está activado, la cadena aleatoria ya no gira ni aleja a esta mascota: solo se reproducen acciones de reposo y en el sitio. Las selecciones con clic derecho, los disparos por API y las animaciones de saldo / susurro / estado de trabajo no se ven afectados.',
  displayLabel: 'Visualización',
  displayHint: 'web = solo navegador / desktop = solo escritorio / both = ambos / none = ninguno',
  'display.web': 'Solo navegador',
  'display.desktop': 'Solo escritorio',
  'display.both': 'Ambos',
  'display.none': 'Ninguno',
  cornerLabel: 'Posición',
  'corner.top-left': 'Arriba a la izquierda',
  'corner.top-right': 'Arriba a la derecha',
  'corner.bottom-left': 'Abajo a la izquierda',
  'corner.bottom-right': 'Abajo a la derecha',
  marginX: 'Margen horizontal',
  marginY: 'Margen vertical',
  save: 'Guardar',
  saveHotkey: 'Ctrl+S / Cmd+S',
  sync: 'Sincronizar',
  confirmSync:
    '¿Sincronizar? Esto sobrescribe la configuración del usuario con la configuración predeterminada incluida (todos los campos + comentarios); las personalizaciones actuales se perderán.',
  corruptTitle: 'La configuración del usuario está dañada; no se guardó',
  corruptConfirm: 'Guardar de todos modos',
  corruptBody:
    'No se puede analizar el archivo de configuración del usuario (dañado, no es JSON/JSONC válido): {path}. Si guardas ahora, se reconstruirá desde la lista blanca: todo lo que hay actualmente en ese archivo (animations / physics / memes…) se perderá. Cancelar = no tocar el archivo (corrígelo y vuelve a guardar); Confirmar = guardar de todos modos (descartar lo que hay en el archivo).',
  syncHint:
    '"Sincronizar" escribe la configuración predeterminada incluida (con comentarios y todos los campos avanzados) en el archivo de configuración del usuario, sobrescribiendo tus personalizaciones actuales; después el archivo se puede editar directamente. Dos advertencias: (1) una vez creado, ese archivo es una capa de sobrescritura explícita: los cambios posteriores en los valores predeterminados incluidos no se aplicarán automáticamente (hasta que vuelvas a sincronizar o borres el archivo); (2) al pulsar "Guardar" en esta página se reescribe el archivo desde una lista blanca: los valores de los campos se conservan, pero los comentarios se pierden.',
  configMeta: 'Avanzado (archivos)',
  configMetaHint:
    'La configuración del usuario puede sobrescribir las mascotas / los pools de animación / los pesos; recarga o reinicia para aplicarlo: recarga la página en el navegador, o haz clic derecho en una mascota de escritorio → "Recargar configuración" (reconstruye todas las ventanas de mascotas de escritorio). La configuración predeterminada es la referencia completa.',
  defaultConfig: 'Configuración predeterminada (solo lectura, referencia completa)',
  userConfig: 'Configuración del usuario (sobrescrituras personalizadas)',
  todosFile:
    'Datos de tareas (texto de la lista, hora de vencimiento y estado de completado; borrarlo vacía todas las tareas)',
  animationDir: 'Directorio de recursos de animación (añade o personaliza animaciones aquí)',
  memesDir: 'Directorio de imágenes de memes (añade o personaliza imágenes aquí)',
  logFile: 'Archivo de registro (para diagnóstico; se puede vaciar)',
  logFileNote:
    'La versión de escritorio no tiene consola, así que todos los registros de ejecución del plugin (inicio, fallos y reinicios de la mascota de escritorio, errores y advertencias) van a este único archivo; adjúntalo al reportar un problema. El límite por archivo es de 1 MB; al llenarse solo se conservan los últimos 512 KB.',
  saved: 'Guardado: las mascotas se actualizaron al instante.',
  loadError: 'No se pudo cargar la configuración',
  saveError:
    'No se pudo guardar la configuración. Revisa la conexión con el servidor, los permisos de escritura del directorio de configuración y el registro del servidor.',
  saveInvalid: 'No se pudo guardar la configuración: el contenido no es válido. Revísalo e inténtalo de nuevo.',
  syncError:
    'No se pudo sincronizar la configuración. Revisa la conexión con el servidor y los permisos de escritura del directorio de configuración.',
  loading: 'Cargando configuración…',
  retry: 'Reintentar',
  invalid: 'Revisa los datos: el tamaño debe ser positivo; los márgenes pueden ser cualquier número.',
  busy: 'Guardando…',
  extraPetsHint:
    'Otras {n} variantes provienen de archivos del directorio pet/ (<nombre>-config.json + <nombre>-animation/). Cambia a ellas en la fila Tipos de arriba; Guardar escribe en la configuración de cada pack, nunca en main-config.jsonc.',
  kindLabel: 'Tipos',
  kindMain: 'Integrado',
  lastOfKind:
    '«{entry}» solo tiene esta mascota; si la eliminas, desaparece todo el tipo. Para quitarlo por completo, borra los archivos del pack de la mascota.',
  savePartial:
    'Las mascotas principales se guardaron, pero {names} no se pudo escribir de vuelta: revisa que la configuración del pack sea válida y que el directorio tenga permisos de escritura.',
  notifyToggle: 'Notificaciones del sistema',
  notifyToggleHint:
    'Avisos del sistema operativo (abajo a la derecha del escritorio) al completarse una conversación, si falla la generación, cuando se solicita permiso o cuando hay que elegir; solo mientras esta ventana no tiene el foco.',
  clickSoundToggle: 'Sonido al hacer clic',
  clickSoundToggleHint:
    'Reproduce el sonido de clic integrado (assets/sound/click-duck.wav, volumen 0.5) al hacer clic en una mascota; los clics repetidos en menos de 100 ms solo suenan una vez, así que varias mascotas nunca se superponen. Desactívalo para silencio total. Se escribe en la configuración del usuario al Guardar.',
  whisperImageToggle: 'Imágenes en susurros',
  whisperImageToggleHint:
    'Adjunta un meme aleatorio del pool a cada susurro (el mapeo de imágenes está en el campo `memes` de la configuración de nivel superior). Tokens: un susurro ya llama al modelo en cada ciclo, así que la imagen solo añade el nombre + la descripción de ese meme (~100 caracteres / ~60 tokens) a la misma solicitud: insignificante.',
  chatImageToggle: 'Imágenes en el chat',
  chatImageToggleHint:
    'Deja que la IA elija un meme del pool que encaje con el contexto actual (opcional; el mapeo está en el campo `memes` de la configuración de nivel superior). Tokens: cada mensaje lleva el catálogo completo, unos 1.1k caracteres (~650 tokens, unas 11 veces el caso de los susurros) y crece con el número de imágenes; si lo desactivas, no se adjunta ni un carácter.',
  chatAnimationToggle: 'Acciones en el chat',
  chatAnimationToggleHint:
    'Cuando está activado, la petición de chat lleva la lista de animaciones que se pueden representar (todas las acciones de animations.categories): si el modelo considera que la frase realmente representa una, la mascota la ejecuta en el acto; si no, responde solo con texto. Tokens: cada mensaje lleva la lista completa; desactivado no se adjunta nada. Valor predeterminado global para todas las mascotas (un pet pack puede sobrescribirlo en su propio archivo de configuración).',
  confineToggle: 'Limitar a la pantalla actual',
  confineToggleHint:
    'Varios monitores: cuando está activado, la mascota solo se mueve dentro de la pantalla en la que está: una mascota lanzada rebota únicamente dentro de la pantalla donde se soltó (las uniones entre pantallas actúan como muros, así que nunca vuela al monitor vecino), y el vagabundeo autónomo solo camina dentro de la pantalla actual (el paso que cruzaría la unión se cancela). Desactívalo para permitir vuelos y caminatas entre pantallas. Solo afecta al modo escritorio: el overlay del navegador ya se queda dentro del viewport.',
  trayToggle: 'Bandeja del sistema',
  trayToggleHint:
    'Muestra un icono en la bandeja (área de notificaciones en Windows, barra de menús en macOS) cuando el modo escritorio está activo. Lista todas las mascotas de la configuración y alterna cada una entre escritorio y web/ninguno, incluidas las que ahora no están en el escritorio y no tienen ventana donde hacer clic derecho. Con esto desactivado, para devolver una mascota al escritorio hay que abrir el navegador (la página de configuración o el clic derecho sobre la mascota web). Windows ya oculta los iconos de terceros en «iconos ocultos». Solo afecta al modo escritorio.',
  voiceTitle: 'Voz',
  voiceHint:
    'Tres interruptores y una voz: el maestro controla la locución automática y los dos secundarios controlan un tipo de mensaje proactivo cada uno. Todo desactivado por defecto; se escribe en la configuración del usuario al "Guardar" (nunca al instante).',
  voiceEnabled: 'Locutar respuestas',
  voiceEnabledHint:
    'Interruptor maestro de la locución automática. Si está desactivado, los susurros periódicos y los recordatorios de tareas quedan en silencio (los dos interruptores de abajo no tienen efecto). Los susurros manuales, las respuestas del chat y el botón de altavoz del panel de chat no dependen de él: los pediste tú, así que la superficie desde la que los pediste los locuta directamente. Solo afecta a si se produce sonido: los globos, la memoria del chat y las notificaciones del sistema no cambian; un fallo de síntesis se registra y nunca interrumpe la conversación.',
  voiceWhisperEnabled: 'Locutar susurros',
  voiceWhisperEnabledHint:
    'Locuta el susurro generado periódicamente (el susurro manual con clic derecho no se ve afectado). Depende del interruptor maestro de arriba. Desactivado por defecto: los susurros son narración de fondo y no deberían sonar sin pedirlo.',
  voiceTodoEnabled: 'Locutar recordatorios de tareas',
  voiceTodoEnabledHint:
    'Locuta el recordatorio de una tarea cuando vence (el globo sigue apareciendo; esto solo decide si se locuta). Depende del interruptor maestro de arriba. Desactivado por defecto.',
  voiceNameLabel: 'Voz',
  physicsTitle: 'Física (sensación al arrastrar y lanzar)',
  physicsHint:
    'Valor predeterminado global, compartido por todas las mascotas (un pet pack puede sobrescribirlo en el archivo de su propio tipo); se escribe en la configuración del usuario al "Guardar" (nunca al instante). En el navegador se aplica al instante; en el escritorio se aplica cuando Guardar recarga las ventanas de mascotas.',
  mobileTitle: 'Efectos móviles',
  mobileHint:
    'Solo tienen sentido en el navegador del móvil: la vibración necesita motor, los dos interruptores de movimiento necesitan sensores de inclinación/aceleración, y los sensores exigen HTTPS o localhost.',
  'physics.gravity': 'Gravedad',
  'physics.gravityHint': 'px/s²: cuanto mayor, más rápido cae; 0 = sin gravedad (vuela en línea recta para siempre)',
  'physics.restitution': 'Rebote',
  'physics.restitutionHint':
    '0–1, velocidad que se conserva al rebotar en una pared o el suelo (1 = completamente elástico, 0 = se detiene en seco)',
  'physics.groundFriction': 'Fricción de contacto',
  'physics.groundFrictionHint':
    'por segundo, amortiguación a lo largo de cualquier superficie (pared, suelo, techo); 0 = hielo en todas',
  'physics.throwPower': 'Fuerza de lanzamiento',
  'physics.throwPowerHint':
    '> 0, multiplicador general del seguimiento con resorte y de la velocidad de salida (1 = predeterminado; más alto = sigue más pegado y lanza más fuerte)',
  physicsCeilingBounce: 'Rebote en el techo',
  physicsCeilingBounceHint:
    'Desactívalo para que un lanzamiento pueda salir por la parte superior de la pantalla (la gravedad sigue tirando de él hacia abajo)',
  physicsPetCollision: 'Colisiones entre mascotas',
  physicsPetCollisionHint: 'Una mascota en vuelo rebota contra las demás conservando el momento (masa ∝ tamaño²)',
  physicsHaptic: 'Vibración al chocar',
  physicsHapticHint:
    'Una vibración por impacto (paredes, suelo, techo, otras mascotas). Funciona en Chrome/Edge; no en iOS ni en navegadores WebView como Via. El modo No molestar la bloquea.',
  physicsTilt: 'Gravedad por inclinación',
  physicsTiltHint:
    'Inclina el móvil y la gravedad lo sigue (magnitud = el valor de arriba); con gravedad en 0 la inclinación no hace nada. Requiere HTTPS/localhost.',
  physicsShake: 'Agitar para lanzar',
  physicsShakeHint:
    'Agita para lanzar la mascota en la dirección del gesto; la fuerza escala con throwPower. No depende de la gravedad, así que funciona con gravedad 0. Requiere HTTPS/localhost.',
  invalidPhysics:
    'Revisa los parámetros de física: gravedad / fricción con el suelo ≥ 0, rebote 0–1, fuerza de lanzamiento > 0.',
  fontTitle: 'Apariencia y fuente',
  fontHint:
    'La familia se aplica a todos los textos que ahora usan la fuente candy: globo de la mascota, tooltip al pasar el cursor, ventana de chat y ventana de puntuación. El tamaño solo se aplica al globo de la mascota y al tooltip (las ventanas de chat y de puntuación conservan su tamaño). Valor predeterminado global, compartido por todas las mascotas (un pet pack puede sobrescribirlo en el archivo de su propio tipo); se escribe en la configuración del usuario al "Guardar": al instante en el navegador y, en el escritorio, cuando Guardar recarga las ventanas de mascotas.',
  fontFamilyLabel: 'Fuente',
  fontFamilyHint:
    '«Candy (integrada)» viene con el plugin; las demás son fuentes del sistema. Si una fuente no está instalada en esta máquina, se usa la siguiente de la pila (nunca queda en blanco ni da error).',
  fontSizeLabel: 'Tamaño de fuente (px)',
  fontSizeHint:
    'Tamaño del texto del globo; el tooltip y las líneas pequeñas dentro del globo se escalan en proporción. Rango 4–200.',
  fontFollowToggle: 'Escalar la fuente con el tamaño de la mascota',
  fontFollowToggleHint:
    'Activado (predeterminado): la fuente crece con la mascota; con 462 px de ancho es exactamente el tamaño de arriba. Desactivado: el tamaño queda fijo sin importar el tamaño de la mascota.',
  invalidFont:
    'Revisa la configuración de la fuente: la familia debe estar en la lista y el tamaño debe ser un número entre 4 y 200.',
  'font.candy': 'Candy (integrada)',
  'font.yahei': 'Microsoft YaHei / PingFang',
  'font.youyuan': 'YouYuan',
  'font.kaiti': 'KaiTi',
  'font.simsun': 'SimSun',
  'font.comic': 'Comic Sans MS',
  'font.system': 'Predeterminada del sistema',
  modelTitle: 'Chat y modelos',
  modelHint:
    'Qué modelo usa cada uno de susurros y chat, y cuánto historial lleva cada solicitud de chat. "Seguir la conversación actual" usa el modelo de tu conversación actual (predeterminado). Valor predeterminado global: se aplica a todas las mascotas y un pet pack puede sobrescribirlo en el archivo de su propio tipo. Las opciones vienen de la misma fuente que el selector de modelos de DSH y el host las sirve en vivo.',
  modelFollow: 'Seguir la conversación actual',
  modelSearch: 'Buscar modelos…',
  modelEmpty: 'No hay modelos que coincidan.',
  modelNoModels: 'No hay modelos disponibles.',
  modelLoading: 'Actualizando la lista de modelos…',
  modelTriggerAria: 'Seleccionar modelo, actual {model}',
  modelUnknown: ' (configuración actual, no está en la lista)',
  modelNone: 'Este proveedor no tiene modelos disponibles',
  whisperModelLabel: 'Modelo de susurros',
  chatModelLabel: 'Modelo de chat',
  modelFieldHint:
    '"Seguir la conversación actual" usa el modelo de la conversación; si el modelo elegido falla, se vuelve al modelo de la conversación y se reintenta una vez.',
  invalidModel:
    'Revisa la configuración del modelo: elige proveedor y modelo, o deja ambos vacíos (seguir la conversación actual).',
  modelCatalogFailed:
    'No se pudo cargar la lista de modelos (recarga la página para reintentar); tus valores actuales se conservan tal cual.',
  chatMemory: 'Rondas de historial del chat',
  chatMemoryHint:
    'Cuántas rondas recientes lleva cada solicitud de chat (1 ronda = 1 pregunta + 1 respuesta; 0 = sin historial, cada mensaje empieza de cero). La memoria en sí lo guarda todo: esto solo decide cuánto entra en el contexto; más rondas recuerdan más y gastan más tokens. Valor predeterminado global, compartido por todas las mascotas (un pet pack puede sobrescribirlo en el archivo de su propio tipo).',
  invalidChatMemory: 'Revisa las rondas de historial del chat: debe ser un número ≥ 0.',
  chatImageLimit: 'Límite de imágenes en el chat',
  chatImageLimitHint:
    'Cuántos memes como máximo se listan al modelo durante el chat ("los primeros N" = los N que escribiste primero en la configuración; mueve al frente los que quieras enviar). Esa lista completa se adjunta a cada mensaje y los tokens crecen de forma lineal con la cantidad, así que una lista larga es puro gasto; limitarla a los primeros N hace que el modelo elija solo entre esos. 0 = sin límite (enviar todo). Valor integrado predeterminado: 10. Valor predeterminado global, compartido por todas las mascotas (un pet pack puede sobrescribirlo en el archivo de su propio tipo). Solo afecta a la selección de imágenes del chat: un susurro lleva solo el meme que sacó.',
  invalidChatImageLimit: 'Revisa el límite de imágenes del chat: debe ser un número ≥ 0 (0 = sin límite).',
  notifyTest: 'Probar notificación',
  notifyTestOk: 'Notificación de prueba enviada; mírala abajo a la derecha del escritorio.',
  notifyDenyUnsupported: 'Este entorno no admite notificaciones del sistema (no hay API Notification).',
  notifyDenyBlocked: 'El navegador tiene bloqueado el permiso de notificaciones.',
  notifyDenyRejected: 'Elegiste «Bloquear» en el aviso de permiso.',
  notifyDenyError: 'Error al solicitar permiso',
  notifyGuide:
    'Guía: haz clic en el icono 🔒/ⓘ junto a la barra de direcciones → Configuración del sitio → Notificaciones → cámbialo a «Permitir» y luego recarga la página y reintenta.',
  storageTitle: 'Desinstalación y almacenamiento',
  storageHint:
    'Todas las ubicaciones que escribe este plugin. Borrar las cachés no rompe nada (se vuelven a descargar/reconstruir); borrar los «datos de usuario del plugin» pierde la configuración y la memoria del chat.',
  'storage.userData':
    'Datos de usuario del plugin: configuración personalizada main-config.jsonc, memoria del chat memory.json, recursos de animación personalizados main-animation/, mascotas de archivo pet/',
  'storage.electron':
    'Runtime de Electron que usa la mascota de escritorio (grande; se vuelve a descargar automáticamente la próxima vez que se active el modo escritorio)',
  'storage.desktopCache':
    'Caché de las ventanas de mascotas de escritorio y caché de escala del monitor principal (se puede borrar, se reconstruye automáticamente)',
  'storage.electronCache':
    'Caché de descarga del instalador de Electron (se puede borrar, se vuelve a descargar cuando haga falta)',
  'storage.package': 'El plugin en sí (lo gestiona DSH: quítalo con el comando de abajo en vez de borrarlo a mano)',
  storageMissing: ' (aún no se ha creado)',
  uninstallTitle: 'Cómo desinstalar',
  uninstallStep1:
    '1. Cierra DSH primero (la mascota de escritorio se cierra con él); no borres estos archivos mientras la mascota esté en ejecución.',
  uninstallStep2:
    '2. Quita el plugin en sí (ejecútalo en la terminal; también lo elimina de la capa de bundles del perfil):',
  uninstallStep3:
    '3. Borra las ubicaciones de arriba según necesites: las cachés no hacen daño; borrar los «datos de usuario del plugin» pierde la configuración y la memoria del chat (haz una copia de main-config.jsonc si quieres conservarla).',
  uninstallCmd: 'dsh plugin --profile {profile} remove dsh-pet',
};
