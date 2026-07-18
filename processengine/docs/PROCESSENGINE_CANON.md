# ProcessEngine: каноническая модель и Flow3 DSL

Статус: каноническая baseline-версия  
Версия документа: 1.0

## 1. Назначение и сила документа

ProcessEngine — фреймворк для построения и устойчивого исполнения долгих доменных бизнес-процессов. Его основная задача — отделить управляющую логику процесса и гарантии исполнения от доменной логики вызываемых сервисов.

Этот документ является основополагающим каноном ProcessEngine и определяет:

- границы ответственности flow-артефакта, runtime, operations и state;
- модель устойчивого и детерминированного исполнения;
- контракт интеграции с доменными сервисами;
- требования к persistence, transport и artifact SPI;
- инварианты process state и operation completion;
- Flow3 DSL как текущую JSON-форму управляющей модели.

Решения ProcessEngine имеют следующий порядок основания:

1. Основополагающие принципы задают направление архитектуры.
2. Каноническая модель определяет семантику компонентов и исполнения.
3. Инварианты уточняют обязательное поведение реализаций.
4. DSL, схемы и примеры воплощают эту семантику в конкретном формате.

При развитии проекта верхний уровень определяет нижний: формат DSL, API пакетов, SPI и connectors развиваются в соответствии с принципами и канонической моделью. Этот канон распространяется на core-пакеты, технологические адаптеры и host-приложения, использующие ProcessEngine.

Flow3 DSL является компактным сериализованным воплощением управляющей модели ProcessEngine. Его ядро содержит три типа шагов:

- `operation` — вызвать операцию;
- `switch` — выбрать следующий шаг по значению в результате операции;
- `end` — завершить процесс.

## 2. Принципы проектирования

Принципы служат критериями для развития всей платформы: core, runtime, state, DSL, SPI и connectors. Новое поле, тип шага, компонент или поведение оценивается по тому, сохраняет ли оно разделение ответственностей, явное происхождение данных и детерминированность исполнения. JSON-формат в следующих разделах является конкретным выражением этих принципов.

### 2.1. Управляющая логика, исполнение, доменная логика и state имеют разных владельцев

Flow-артефакт владеет управляющей логикой процесса: последовательностью operations, выбором продолжения и предусмотренными завершениями. Runtime владеет устойчивым исполнением артефакта: хранением, доставкой, корреляцией, ожиданием, технической политикой и восстановлением. Operations владеют доменной логикой, вычислением значений и преобразованием структур. State хранит факты конкретного исполнения: вход процесса, completions, текущую позицию и терминальный результат.

Эти границы задают критерий размещения каждой новой возможности:

- выбор следующего действия выражается в flow-артефакте;
- вычисление или изменение бизнес-значения реализуется operation;
- обеспечение надёжности относится к runtime и его SPI;
- факт, необходимый для восстановления исполнения, сохраняется в state.

В формате этот принцип выражен разделением ролей: `operation` вызывает доменное поведение, `switch` выбирает control-переход, `end` фиксирует предусмотренный исход, а `input` адресует уже сохранённые данные. Runtime сохраняет payload без доменной интерпретации и преобразования; единственной структурной операцией над ним является объявленное в `switch` чтение верхнеуровневого `key`.

### 2.2. Интеграция строится вокруг контракта сервиса

Доменный контракт сервиса является источником семантики его ответа. Operation integration предоставляет два явных канала завершения — `response` и `error`; connector доставляет выбранный канал, а runtime формирует канонический completion, сохраняя доменный payload без преобразования. Статус completion определяется протоколом operation, а не анализом содержимого payload.

Flow-артефакт описывает использование этого контракта со стороны процесса: указывает источник результата и верхнеуровневый признак, по которому выбирается продолжение. Это позволяет включать существующие сервисы в новый процесс через явное описание их контрактов.

В формате этот принцип выражен парой `key` и `routes` у `switch`. Изменение используемого контракта сервиса сопровождается проверкой совместимости и новой версией flow, когда меняется логика процесса.

### 2.3. Process state является источником данных для шагов

Каждый completion сохраняется в устойчивом state под `stepId` выполнившейся operation. Последующие шаги получают данные, разрешая явно объявленный адрес уже сохранённого `response` или `error`.

Control-переходы задают только порядок исполнения, а `input` задаёт отдельную зависимость от данных. Благодаря этому источник значения виден в артефакте, сохраняется после перезапуска и проверяется независимо от расположенных между producer и consumer шагов.

В формате этот принцип выражен единым контрактом `StepInput` с полями `step` и `resultType`, который используют `operation`, `switch` и `end`. Начальная operation получает неизменяемый input экземпляра процесса согласно контракту запуска.

### 2.4. Каждый шаг объявляет один целостный input

Потребляющий шаг адресует один `response` или `error` одной operation, которая гарантированно завершилась раньше на пути к этому шагу. Runtime извлекает указанное значение из state целиком.

В формате этот принцип выражен полем `input` в единственном числе и фиксированной грамматикой `{ step, resultType }`. Такая ссылка сохраняет точное происхождение данных и остаётся статически проверяемой.

Сценарий, которому требуется новое бизнес-представление данных, выражается отдельной operation и новым completion в state. Так DSL остаётся языком оркестрации, а процессинг данных остаётся частью доменного контура.

### 2.5. Ветвление имеет минимальную детерминированную алгебру

`Switch` выполняет строгое сравнение одного верхнеуровневого строкового признака с конечной таблицей переходов. Результат выбора зависит только от входного значения и flow-артефакта.

В формате этот принцип выражен тремя частями: `input` задаёт проверяемое значение, `key` — буквальное имя верхнеуровневого поля, `routes` — отображение допустимых строковых значений на `stepId`.

Сложное доменное решение оформляется operation, которая возвращает явный верхнеуровневый признак. Развитие `switch` должно сохранять локальность, строгую проверяемость и одинаковый результат при повторном исполнении.

### 2.6. Маршрутизация выражает закрытый контракт

Таблица `routes` перечисляет полный набор значений признака, которые flow принимает в этой точке. Каждое значение связано с определённым следующим шагом, а значение за пределами набора означает нарушение согласованности flow и контракта operation.

При наличии JSON Schema компилятор сопоставляет `routes` со строковым перечислением признака и проверяет полноту таблицы. При отсутствии схемы runtime проверяет принадлежность значения объявленному набору и переводит нарушение контракта в `FAULTED`.

Этот принцип делает расширение контракта осознанным изменением процесса: новое допустимое значение получает явно спроектированное продолжение.

### 2.7. Completion является каноническим итогом operation

После завершения технической политики runtime фиксирует один окончательный completion. Его форма одинакова для всех operations и представляет взаимоисключающие результаты `SUCCESS` и `ERROR`:

```text
SUCCESS => response присутствует или равен null, error = null
ERROR   => response = null, error присутствует
```

Все три поля присутствуют явно. Успешно вычисленный бизнес-результат, включая `response.errors`, относится к `SUCCESS`. `ERROR` фиксирует окончательную неспособность operation сформировать успешный response. Источником `ERROR` выступает явный error-канал operation либо runtime, исчерпавший техническую политику выполнения.

Каноническая форма completion задаёт единый контракт для connectors, persistence и следующих шагов процесса. Явные `null` сохраняют взаимоисключаемость результатов непосредственно в данных.

### 2.8. Техническая политика завершается до логического перехода

Retry, timeout, backoff, доставка и ожидание определяют, как runtime получает окончательный результат operation. Runtime применяет эту политику целиком, затем фиксирует один completion и выполняет единственный логический переход.

Вызов operation проходит две самостоятельные технические фазы. В фазе dispatch runtime устойчиво публикует command согласно политике доставки. В фазе completion runtime ожидает ответ уже опубликованного command. Отсчёт `completionTimeout` начинается только после того, как подтверждённая транспортом публикация зафиксирована в persistence. Исчерпание попыток dispatch и истечение ожидания completion являются разными техническими исходами и наблюдаются раздельно.

В формате `next` соответствует окончательному `SUCCESS`, а `onError` — окончательному `ERROR`. Конфигурация технической политики принадлежит operation runtime, а сведения о попытках и транспорте хранятся в служебных записях исполнения.

Так flow-артефакт описывает управляющую логику процесса, а техническая политика может развиваться независимо для разных connectors и окружений.

### 2.9. Повторная доставка сохраняет единственность доменного действия

Transport работает по модели at-least-once: command и completion могут быть доставлены повторно после сетевого сбоя, потери подтверждения или восстановления инстанса. Один логический вызов operation получает стабильный `requestId`, который сохраняется при всех повторных публикациях и восстановлении.

Operation integration использует `requestId` как ключ crash-safe дедупликации. Факт обработки запроса и доменный side effect фиксируются в одной транзакции либо в эквивалентной атомарной границе; повторный command возвращает сохранённый completion и не выполняет side effect заново. Это требование относится к интеграции operation, поскольку только она владеет доменной транзакцией вызываемого сервиса.

Runtime принимает не более одного completion ожидаемого вызова. Повторные completion с тем же `requestId` не создают новый переход и не заменяют уже сохранённый результат. Так логическая семантика exactly-once достигается поверх физической доставки at-least-once на обеих границах.

### 2.10. Корреляция completion опирается на явную идентичность маршрута

Operation binding связывает логический идентификатор operation с destination команды, ожидаемым `completionSource` и технической политикой. `CompletionSource` является стабильной routing identity интеграции, которая сформировала completion.

Runtime принимает completion, только когда одновременно совпадают ожидаемый `requestId`, destination ответов host-приложения, идентичность экземпляра процесса и объявленный binding-ом `completionSource`. Корреляция проверяется до изменения state; несовместимое сообщение не участвует в исполнении процесса.

Routing identity определяет ожидаемого участника протокола, но сама по себе не доказывает его подлинность. Аутентификация и авторизация обеспечиваются защищённым transport-контуром: ACL брокера, учётными данными, TLS/mTLS, подписями или эквивалентными механизмами конкретного connector.

### 2.11. State является детерминированным снимком исполнения

Устойчивый state содержит все данные, необходимые для однозначного выбора следующего логического перехода: закреплённую версию flow, неизменяемый process input, текущий шаг, ожидаемую operation, принятые completions и терминальный результат.

В формате каждый completion хранится в `results[stepId]`, ожидаемое действие — в `pending`, а `revision` монотонно отмечает принятые переходы. `StepId` связывает результат с конкретным местом operation в графе, даже когда один логический идентификатор operation используется повторно.

Одинаковый state и одинаковый flow всегда приводят runtime к одному следующему решению. Реализации persistence SPI должны сохранять эту семантику при конкурентном доступе и восстановлении после сбоя.

### 2.12. Доменное завершение и целостность исполнения образуют разные исходы

`End` фиксирует предусмотренный доменный исход графа и переводит экземпляр в `COMPLETED`. Такой исход может означать успех, бизнес-отказ или обработанный технический результат — например, `PAYMENT_VALID`, `VALIDATION_FAILED` или `VALIDATION_UNAVAILABLE`.

`FAULTED` фиксирует нарушение целостности исполнения: несовместимый completion, недоступный input или значение вне закрытого контракта маршрутизации. Это различие позволяет наблюдаемости и автоматическому восстановлению отличать завершённый бизнес-сценарий от неисправности самого процесса.

В формате `end` задаёт `outcome` и при необходимости один терминальный `response` либо `error`; runtime устанавливает `FAULTED` непосредственно при нарушении контракта исполнения.

### 2.13. Три примитива образуют ортогональное ядро

`Operation` производит значение, `switch` выбирает продолжение, `end` фиксирует результат. У каждого примитива одна роль, а их последовательная композиция образует полный цикл долгого бизнес-процесса.

Новые возможности сначала раскладываются по этим ролям: бизнес-вычисление относится к operation, логический выбор — к switch, завершение — к end, устойчивость выполнения — к runtime. Новый примитив оправдан только тогда, когда появляется новая самостоятельная семантическая роль и её невозможно выразить композицией существующих без потери явности и детерминизма.

## 3. Каноническая модель ProcessEngine

### 3.1. Определение процесса

Process definition — неизменяемый версионированный артефакт управляющей логики. Он задаёт последовательность operations, правила выбора продолжения, предусмотренные завершения и адреса данных, которые требуются шагам.

Каждый запущенный экземпляр закрепляется за конкретными `id` и `version` definition. Повторное исполнение сохранённого state всегда использует ту же версию артефакта.

Текущим форматом process definition является Flow3 DSL.

### 3.2. Экземпляр и state

Process instance — отдельное исполнение definition со своим `instanceId` и устойчивым state. State хранит вход процесса, текущую позицию, ожидаемую operation, принятые completions, revision и терминальный результат.

State является авторитетным источником фактов исполнения. Runtime принимает логические решения только на основании закреплённого definition и зафиксированного state. Persistence SPI сохраняет state и переходы атомарно и защищает revision от конкурирующих обновлений. Artifact SPI гарантирует неизменяемость definition, адресуемого закреплённой парой `{ id, version }`.

### 3.3. Runtime

Runtime интерпретирует process definition и устойчиво продвигает экземпляр от одного шага к следующему. Он:

- разрешает текущий шаг и его объявленный input;
- создаёт и коррелирует вызовы operations;
- применяет timeout, retry и другие технические политики;
- принимает один окончательный completion;
- атомарно сохраняет результат и следующий логический переход;
- восстанавливает продолжение после остановки или сбоя.

Runtime выполняет по одному логическому переходу экземпляра за раз. Его решения детерминированы сочетанием definition и state.

Для каждого вызова runtime создаёт стабильный `requestId` и durable outbox-запись в одной транзакции с переводом процесса в ожидание. Публикация command повторяется с тем же `requestId` до подтверждения transport или исчерпания dispatch policy. Только зафиксированная подтверждённая публикация открывает фазу ожидания completion и устанавливает её deadline. Восстановившийся runtime продолжает любую из фаз по сохранённым служебным записям независимо от того, какой инстанс выполнял предыдущую попытку.

Цикл технических workers внутри одного runtime выполняется как single flight. Между runtime-инстансами владение ограничено lease и монотонным fencing token; каждый повторный захват истёкшего lease считается новой dispatch-попыткой с теми же `requestId` и `messageId`. Длительность lease должна превышать верхнюю границу одного вызова transport `publish`, чтобы действующий владелец не был вытеснен во время ещё выполняющейся публикации.

Completion проходит протокольную проверку и корреляцию с сохранённым вызовом до логического перехода. Атомарная запись inbox, completion, нового state и следующего outbox-действия обеспечивает единственность принятия результата при повторной доставке и конкуренции нескольких runtime-инстансов.

### 3.4. Operation

Operation — граница доменного поведения. Она получает один объявленный business payload и завершает вызов через явный success-канал с доменным `response` либо error-канал с окончательным `error`. Локальная функция, отдельный микросервис и legacy-интеграция равноправны для ядра, если их operation integration соблюдает этот контракт.

Operations реализуют вычисления, валидацию, преобразование данных и side effects. Runtime хранит payload как непрозрачное JSON-значение и использует только явно объявленный flow-артефактом верхнеуровневый признак для control-перехода.

Operation integration существующего сервиса включает явный адаптер его протокола к success- и error-каналам ProcessEngine. Этот адаптер является частью интеграционного кода operation и регистрируется вместе с её контрактом; core применяет одинаковую completion-семантику ко всем integrations.

Operation integration также является владельцем доменной идемпотентности. Она сохраняет `requestId` и доменный side effect в одной атомарной границе, а при повторном command воспроизводит ранее сохранённый completion. Transport и runtime могут повторно доставить тот же command, но не могут атомарно защитить данные чужого сервиса.

### 3.5. SPI, connectors и композиция host-приложения

Core определяет технологически нейтральные контракты:

- persistence SPI сохраняет process state, служебные записи исполнения и атомарные переходы;
- transport SPI доставляет вызовы operations и их результаты;
- artifact SPI хранит и загружает неизменяемые process definitions по `{ id, version }`;
- operation registry связывает логический идентификатор operation с destination команды, ожидаемым `completionSource`, контрактом данных и технической политикой.

Connector переводит контракт core в возможности конкретной технологии, сохраняя каноническую семантику completion, корреляции и восстановления. Host-приложение является composition root: выбирает connectors, передаёт их конфигурацию, регистрирует bindings доменных operations и process definitions, а также добавляет внешние API. Такая граница оставляет технологические пакеты независимыми и делает состав конкретного контура явным в его host-коде.

`CompletionSource` используется вместе с destination ответов, идентичностью экземпляра и `requestId` для корреляции сообщения с ожидаемым вызовом. Это поле является частью routing-протокола. Connector и окружение отдельно обеспечивают доверие к заявленной идентичности через механизмы аутентификации и авторизации транспорта.

### 3.6. Исполнение одного процесса

Процесс является ациклическим ориентированным графом control-переходов. `next`, `onError` и `routes` определяют последовательность шагов. В один момент времени runtime исполняет не более одного шага экземпляра.

Данные процесса находятся в устойчивом state. Каждый потребляющий шаг независимо объявляет, какой уже сохранённый результат ему требуется. Runtime исполняет эту модель следующим образом:

- исходный input процесса поступает в начальную operation;
- completion operation сохраняется в `state.results[stepId]`;
- `input.step` указывает на ранее выполненную operation, а `input.resultType` выбирает её `response` или `error`;
- `switch` читает указанное значение из state и выбирает следующий control-переход;
- следующая operation читает собственный `input` из state и получает это значение целиком;
- её completion сохраняется в state как отдельный результат;
- `end` читает собственный `input` и при необходимости фиксирует значение как терминальный результат процесса.

Один step исполняется не более одного раза, поэтому каждый `results[stepId]` имеет однозначный смысл. Компилятор проверяет, что producer гарантированно завершён на каждом control-пути, по которому может быть достигнут consumer.

## 4. Flow3 DSL: артефакт процесса

```json
{
  "id": "shop.checkout",
  "version": "1.0.0",
  "start": "validate-payment",
  "steps": {
    "validate-payment": {
      "type": "operation",
      "operation": "payment.validate",
      "next": "route-validation",
      "onError": "route-validation-error"
    },
    "route-validation": {
      "type": "switch",
      "input": {
        "step": "validate-payment",
        "resultType": "response"
      },
      "key": "resultCode",
      "routes": {
        "VALID": "payment-valid",
        "INVALID": "remap-errors"
      }
    },
    "remap-errors": {
      "type": "operation",
      "operation": "errors.remap",
      "input": {
        "step": "validate-payment",
        "resultType": "response"
      },
      "next": "validation-failed",
      "onError": "route-remap-error"
    },
    "route-validation-error": {
      "type": "switch",
      "input": {
        "step": "validate-payment",
        "resultType": "error"
      },
      "key": "code",
      "routes": {
        "PAYMENT_REQUEST_INVALID": "validation-rejected",
        "PAYMENT_SERVICE_UNAVAILABLE": "validation-unavailable"
      }
    },
    "route-remap-error": {
      "type": "switch",
      "input": {
        "step": "remap-errors",
        "resultType": "error"
      },
      "key": "code",
      "routes": {
        "ERROR_REMAP_REJECTED": "remap-rejected",
        "ERROR_REMAP_UNAVAILABLE": "remap-unavailable"
      }
    },
    "payment-valid": {
      "type": "end",
      "outcome": "PAYMENT_VALID"
    },
    "validation-failed": {
      "type": "end",
      "outcome": "VALIDATION_FAILED",
      "input": {
        "step": "remap-errors",
        "resultType": "response"
      }
    },
    "validation-rejected": {
      "type": "end",
      "outcome": "VALIDATION_REJECTED",
      "input": {
        "step": "validate-payment",
        "resultType": "error"
      }
    },
    "validation-unavailable": {
      "type": "end",
      "outcome": "VALIDATION_UNAVAILABLE",
      "input": {
        "step": "validate-payment",
        "resultType": "error"
      }
    },
    "remap-rejected": {
      "type": "end",
      "outcome": "ERROR_REMAP_REJECTED",
      "input": {
        "step": "remap-errors",
        "resultType": "error"
      }
    },
    "remap-unavailable": {
      "type": "end",
      "outcome": "ERROR_REMAP_UNAVAILABLE",
      "input": {
        "step": "remap-errors",
        "resultType": "error"
      }
    }
  }
}
```

Поля верхнего уровня:

- `id` — стабильный идентификатор процесса;
- `version` — версия бизнес-процесса;
- `start` — идентификатор начального шага;
- `steps` — карта шагов по уникальным `stepId`.

## 5. Completion операции

Completion — внутренний унифицированный результат завершённой operation. Operation implementation или её явно зарегистрированный integration adapter выбирает success- либо error-канал как часть контракта вызова. Runtime принимает этот выбор без классификации business payload и формирует completion. Runtime также формирует error-channel completion для собственного окончательного технического исхода: исчерпания dispatch policy либо completion timeout после подтверждённой публикации command.

Успешный completion:

```json
{
  "status": "SUCCESS",
  "response": {
    "resultCode": "INVALID",
    "errors": [
      {
        "code": "10002",
        "message": "Payment amount exceeds the limit",
        "field": "amount",
        "details": {
          "limit": 100000,
          "actual": 120000
        }
      },
      {
        "code": "10003",
        "message": "Invalid card number",
        "field": "card.number",
        "details": null
      }
    ]
  },
  "error": null
}
```

Окончательная ошибка:

```json
{
  "status": "ERROR",
  "response": null,
  "error": {
    "code": "PAYMENT_SERVICE_UNAVAILABLE",
    "message": "Payment service is unavailable",
    "details": null
  }
}
```

У completion всегда присутствуют три поля:

- `status` — `SUCCESS` или `ERROR`;
- `response` — успешный ответ operation;
- `error` — окончательная ошибка operation.

Канонический контракт ошибки:

```ts
type OperationError = {
  code: string;
  message: string;
  details: JsonValue | null;
};
```

Доменная operation и runtime-generated failure используют одну форму. Коды технических ошибок runtime принадлежат стабильному контракту core. Integration adapter существующего сервиса явно приводит его error-протокол к `OperationError` на границе operation.

Инварианты:

```text
status = SUCCESS  => error = null
status = ERROR    => response = null и error != null
```

Успешная operation без тела ответа может вернуть `response: null`. Её результат однозначно определяется полем `status`.

Признак возможности retry, количество попыток и причины прекращения повторов в completion не сохраняются. Runtime применяет техническую политику до формирования окончательного `ERROR` и хранит служебные сведения отдельно от process state.

Runtime сохраняет `response` и содержимое `error` без доменной интерпретации и преобразования. `Switch` выполняет только объявленное чтение одного верхнеуровневого `key`. Транспортный envelope, headers, correlation ID и другие служебные данные хранятся отдельно от business payload.

Transport может доставить несколько completion одного логического вызова. Runtime коррелирует каждый envelope с сохранённой operation по `requestId`, destination ответов, instance identity и ожидаемому `completionSource`; только первый completion, атомарно принятый для ещё ожидающей operation, становится частью process state. Следующие дубли не изменяют результат и не выполняют переход повторно.

## 6. Явное ребро данных `input`

Operation, switch и end используют одинаковый адрес одного сохранённого результата предыдущей operation:

```json
{
  "step": "validate-payment",
  "resultType": "response"
}
```

Контракт ссылки:

```ts
type StepInput = {
  step: StepId;
  resultType: "response" | "error";
};
```

Поля `step` и `resultType` образуют точный адрес значения в process state:

```text
resultType = response
    => input = state.results[step].response

resultType = error
    => input = state.results[step].error
```

Runtime разыменовывает адрес и передаёт полученное значение целиком. Грамматика `StepInput` разрешает одно чтение целого `response` или `error` одного producer.

`step` указывает на operation, которая гарантированно завершилась до consumer на каждом ведущем к нему control-пути. Между producer и consumer могут находиться другие steps. Результат остаётся доступным в state после выполнения последующих operations.

Компилятор проверяет доминирование producer над consumer и совместимость `resultType` с переходом, по которому результат operation был принят. Runtime повторно проверяет наличие и форму completion перед разыменованием ссылки.

## 7. State процесса

```json
{
  "instanceId": "checkout-123",
  "flow": {
    "id": "shop.checkout",
    "version": "1.0.0"
  },
  "lifecycle": "RUNNING",
  "revision": 0,
  "currentStep": "validate-payment",
  "input": {
    "amount": 120000,
    "currency": "RUB",
    "card": {
      "number": "123"
    }
  },
  "results": {},
  "pending": null,
  "outcome": null,
  "response": null,
  "error": null
}
```

Поля:

- `instanceId` — идентификатор экземпляра;
- `flow` — закреплённая версия процесса;
- `lifecycle` — состояние исполнения;
- `revision` — номер сохранённого состояния;
- `currentStep` — текущий шаг;
- `input` — неизменяемый исходный input процесса;
- `results` — completion выполненных operations по их `stepId`;
- `pending` — ожидаемая operation;
- `outcome` — доменный исход завершённого процесса;
- `response` — терминальный успешный ответ;
- `error` — терминальная ошибка.

Lifecycle:

- `RUNNING` — runtime выполняет переход;
- `WAITING` — runtime ожидает результат operation;
- `COMPLETED` — процесс достиг end;
- `FAULTED` — runtime не может корректно продолжить процесс из-за нарушения контракта или state.

Достижение end всегда означает `COMPLETED`, включая отрицательный или технический доменный outcome. `FAULTED` используется только для неисправности исполнения самого процесса.

## 8. Шаг `operation`

### 8.1. Начальная operation

```json
{
  "type": "operation",
  "operation": "payment.validate",
  "next": "route-validation",
  "onError": "route-validation-error"
}
```

Шаг, указанный в `start`, получает неизменяемый `state.input`. Поле `input` у начальной operation отсутствует, потому что источником по определению является вход процесса.

### 8.2. Последующая operation

```json
{
  "type": "operation",
  "operation": "errors.remap",
  "input": {
    "step": "validate-payment",
    "resultType": "response"
  },
  "next": "validation-failed",
  "onError": "route-remap-error"
}
```

Поля:

- `operation` — логический идентификатор вызываемой operation;
- `input` — единственный источник входных данных;
- `next` — следующий шаг после `SUCCESS`;
- `onError` — следующий шаг после окончательного `ERROR`.

При `SUCCESS` runtime сохраняет completion и переходит в `next`. При окончательном `ERROR` runtime сохраняет completion и переходит в `onError`.

Runtime разрешает `input` через `state.results[step][resultType]` и передаёт полученное значение вызываемой operation целиком. Транспортный connector может добавить служебный envelope, но он не является частью business payload.

У operation может быть не более одного `input`. Он всегда ссылается на один результат одного производящего шага.

## 9. Шаг `switch`

```json
{
  "type": "switch",
  "input": {
    "step": "validate-payment",
    "resultType": "response"
  },
  "key": "resultCode",
  "routes": {
    "VALID": "payment-valid",
    "INVALID": "remap-errors"
  }
}
```

Поля:

- `input` — единственный проверяемый response или error;
- `key` — имя одного верхнеуровневого поля в input;
- `routes` — отображение строкового значения поля на следующий `stepId`.

Семантика:

```text
input = resolve(step.input)
value = input[step.key]
nextStep = step.routes[value]
```

`key` всегда трактуется как буквальное имя верхнеуровневого поля. Точка, `/`, квадратные скобки или другие символы внутри имени не превращают его в путь.

Значение `input[key]` должно быть строкой. Сравнение выполняется без преобразования типов. Ключи `routes` также являются строками.

Switch читает объявленный `input` из state и выбирает control-переход. Каждый следующий потребляющий шаг самостоятельно разрешает собственный `input`.

Если input не является объектом, key отсутствует, значение не является строкой или в `routes` нет такого значения, процесс становится `FAULTED`. Неявного default-перехода нет.

## 10. Шаг `end`

End завершает процесс и фиксирует `outcome`.

Без возвращаемых данных:

```json
{
  "type": "end",
  "outcome": "PAYMENT_VALID"
}
```

С успешным ответом:

```json
{
  "type": "end",
  "outcome": "VALIDATION_FAILED",
  "input": {
    "step": "remap-errors",
    "resultType": "response"
  }
}
```

С ошибкой:

```json
{
  "type": "end",
  "outcome": "VALIDATION_UNAVAILABLE",
  "input": {
    "step": "validate-payment",
    "resultType": "error"
  }
}
```

При `resultType: response`:

```text
state.response = state.results[step].response
state.error = null
```

При `resultType: error`:

```text
state.response = null
state.error = state.results[step].error
```

Если `input` отсутствует, `response` и `error` равны `null`. Одновременно вернуть response и error нельзя.

## 11. Выполнение примера

### 11.1. Запуск

Начальная operation `validate-payment` получает исходный input:

```json
{
  "amount": 120000,
  "currency": "RUB",
  "card": {
    "number": "123"
  }
}
```

### 11.2. Ответ валидации

Микросервис возвращает доменный ответ согласно собственному API-контракту. Flow использует его верхнеуровневое поле `resultCode` для выбора продолжения:

```json
{
  "resultCode": "INVALID",
  "errors": [
    {
      "code": "10002",
      "message": "Payment amount exceeds the limit",
      "field": "amount",
      "details": {
        "limit": 100000,
        "actual": 120000
      }
    },
    {
      "code": "10003",
      "message": "Invalid card number",
      "field": "card.number",
      "details": null
    }
  ]
}
```

Runtime сохраняет успешный completion под `stepId`:

```json
{
  "currentStep": "route-validation",
  "results": {
    "validate-payment": {
      "status": "SUCCESS",
      "response": {
        "resultCode": "INVALID",
        "errors": [
          {
            "code": "10002",
            "message": "Payment amount exceeds the limit",
            "field": "amount",
            "details": {
              "limit": 100000,
              "actual": 120000
            }
          },
          {
            "code": "10003",
            "message": "Invalid card number",
            "field": "card.number",
            "details": null
          }
        ]
      },
      "error": null
    }
  }
}
```

### 11.3. Проверка key

`route-validation` получает `validate-payment.response` и выполняет:

```text
input["resultCode"] = "INVALID"
routes["INVALID"] = "remap-errors"
```

Следующим становится `remap-errors`. Его `input` явно адресует сохранённый `validate-payment.response`.

### 11.4. Передача response следующей operation

`remap-errors.input` указывает на `validate-payment.response`, поэтому `errors.remap` получает:

```json
{
  "resultCode": "INVALID",
  "errors": [
    {
      "code": "10002",
      "message": "Payment amount exceeds the limit",
      "field": "amount",
      "details": {
        "limit": 100000,
        "actual": 120000
      }
    },
    {
      "code": "10003",
      "message": "Invalid card number",
      "field": "card.number",
      "details": null
    }
  ]
}
```

### 11.5. Результат remap

`errors.remap` возвращает:

```json
{
  "errorsList": [
    {
      "message": "Payment amount exceeds the limit",
      "field": "amount"
    },
    {
      "message": "Invalid card number",
      "field": "cardNumber"
    }
  ]
}
```

Runtime сохраняет второй completion:

```json
{
  "currentStep": "validation-failed",
  "results": {
    "validate-payment": {
      "status": "SUCCESS",
      "response": {
        "resultCode": "INVALID",
        "errors": [
          {
            "code": "10002",
            "message": "Payment amount exceeds the limit",
            "field": "amount",
            "details": {
              "limit": 100000,
              "actual": 120000
            }
          },
          {
            "code": "10003",
            "message": "Invalid card number",
            "field": "card.number",
            "details": null
          }
        ]
      },
      "error": null
    },
    "remap-errors": {
      "status": "SUCCESS",
      "response": {
        "errorsList": [
          {
            "message": "Payment amount exceeds the limit",
            "field": "amount"
          },
          {
            "message": "Invalid card number",
            "field": "cardNumber"
          }
        ]
      },
      "error": null
    }
  }
}
```

### 11.6. Завершение с response

`validation-failed.input` указывает на `remap-errors.response`. Терминальный state:

```json
{
  "lifecycle": "COMPLETED",
  "outcome": "VALIDATION_FAILED",
  "response": {
    "errorsList": [
      {
        "message": "Payment amount exceeds the limit",
        "field": "amount"
      },
      {
        "message": "Invalid card number",
        "field": "cardNumber"
      }
    ]
  },
  "error": null
}
```

### 11.7. Техническая ошибка

Если integration adapter `payment.validate` получает от сервиса недоступность и завершает вызов через error-канал, runtime после применения технической политики сохраняет переданный operation error:

```json
{
  "status": "ERROR",
  "response": null,
  "error": {
    "code": "PAYMENT_SERVICE_UNAVAILABLE",
    "message": "Payment service is unavailable",
    "details": null
  }
}
```

`route-validation-error` получает `validate-payment.error`, читает верхнеуровневый `code` и выполняет:

```text
input["code"] = "PAYMENT_SERVICE_UNAVAILABLE"
routes["PAYMENT_SERVICE_UNAVAILABLE"] = "validation-unavailable"
```

`validation-unavailable.input` указывает на тот же error. Терминальный state:

```json
{
  "lifecycle": "COMPLETED",
  "outcome": "VALIDATION_UNAVAILABLE",
  "response": null,
  "error": {
    "code": "PAYMENT_SERVICE_UNAVAILABLE",
    "message": "Payment service is unavailable",
    "details": null
  }
}
```

## 12. Статические проверки

Компилятор отклоняет артефакт, если:

1. `start` не указывает на operation.
2. `stepId` повторяется или переход указывает на отсутствующий шаг.
3. Неизвестен `type` шага.
4. Начальная operation содержит `input`.
5. Последующая operation не содержит `input`.
6. Switch не содержит `input`, `key` или непустой `routes`.
7. `input.step` не указывает на operation, гарантированно завершённую до consumer на каждом ведущем к нему control-пути.
8. Граф control-переходов содержит цикл.
9. `input.resultType` не равен `response` или `error`.
10. `response` запрашивается на пути окончательного `ERROR` либо `error` — на пути `SUCCESS`.
11. `key` пуст или интерпретируется не как буквальное имя верхнеуровневого поля.
12. Ключи `routes` повторяются или указывают на отсутствующие шаги.
13. End содержит переходы.
14. `end.input` ссылается на недоступный результат.
15. Step недостижим из `start`.
16. Достижимый control-путь обрывается до `end`.

Если для operations зарегистрированы JSON Schema, компилятор дополнительно проверяет:

- совместимость process input с input-схемой начальной operation;
- совместимость выбранного `response` или `error` producer с input-схемой consumer operation;
- существование `switch.key`, его строковый тип, совместимость значений `routes` и полное покрытие объявленного строкового enum.

Без схемы доступность результата, форма completion, доступность `key`, его тип и принадлежность значения таблице `routes` проверяются runtime. Содержательную совместимость business payload в этом случае гарантирует контракт host-приложения.

## 13. Инварианты исполнения

1. Одновременно выполняется не более одной operation экземпляра процесса.
2. Каждый step исполняется не более одного раза, и в `results[stepId]` сохраняется один принятый completion соответствующей operation.
3. Незавершённая operation находится в `pending` и отсутствует в `results`.
4. Все три поля completion присутствуют всегда.
5. `SUCCESS` требует `error: null`.
6. `ERROR` требует `response: null` и непустой `error`.
7. Оркестратор не изменяет `response` и `error`.
8. Потребляющий шаг разрешает из state ровно один целостный input одной ранее завершённой operation.
9. Switch читает только один верхнеуровневый строковый key.
10. Switch не изменяет передаваемый input.
11. End возвращает не более одного значения: response либо error.
12. Отсутствующий input, неизвестное значение routes или несовместимый тип переводят процесс в `FAULTED`.
13. Повторные попытки, таймауты и транспортные данные не являются частью DSL или completion.
14. Один логический вызов operation имеет стабильный `requestId` при повторной публикации и восстановлении.
15. Command и completion доставляются at-least-once; runtime атомарно принимает не более одного completion ожидаемого вызова.
16. Completion изменяет state только при совпадении `requestId`, destination ответов, instance identity и объявленного `completionSource`.
17. `CompletionSource` является routing identity; доверие к ней обеспечивают аутентификация и авторизация transport-контура.
18. Отсчёт completion timeout начинается после устойчивой фиксации подтверждённой публикации command.
19. Исчерпание dispatch policy и completion timeout являются разными техническими исходами.
20. Operation integration атомарно связывает доменный side effect с `requestId` и воспроизводит сохранённый completion при повторном command.
