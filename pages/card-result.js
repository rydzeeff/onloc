// pages/card-result.js
import Head from "next/head";
import { useRouter } from "next/router";
import styles from "../styles/card-result.module.css";

function pickQueryValue(v) {
  if (Array.isArray(v)) return v[0];
  return v ?? "";
}

function StatusIcon({ variant }) {
  return (
    <span
      className={[
        styles.iconWrap,
        variant === "success" ? styles.iconSuccess : "",
        variant === "error" ? styles.iconError : "",
        variant === "loading" ? styles.iconLoading : "",
      ].join(" ")}
      aria-hidden="true"
    >
      {variant === "loading" ? (
        <span className={styles.spinner} />
      ) : variant === "success" ? (
        <svg viewBox="0 0 24 24" className={styles.iconSvg}>
          <path
            d="M20 6L9 17l-5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className={styles.iconSvg}>
          <path
            d="M18 6L6 18M6 6l12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

export default function CardResult() {
  const router = useRouter();

  const status = pickQueryValue(router.query.status);
  const Success = pickQueryValue(router.query.Success);
  const ErrorCode = pickQueryValue(router.query.ErrorCode);
  const Message = pickQueryValue(router.query.Message);

  // совместимость: status=success|error и Success=true|false
  const isSuccess = status === "success" || Success === "true";
  const isLoading = !status && !Success && !ErrorCode;

  // action: bind / unbind (и синонимы)
  const actionRaw = (
    pickQueryValue(router.query.action) ||
    pickQueryValue(router.query.Action) ||
    pickQueryValue(router.query.operation) ||
    pickQueryValue(router.query.Operation) ||
    "bind"
  )
    .toString()
    .toLowerCase();

  const isUnbind = ["unbind", "unlink", "detach", "remove", "delete", "отвязка"].includes(
    actionRaw
  );

  const title = isLoading
    ? "Обрабатываем результат"
    : isSuccess
    ? isUnbind
      ? "Карта успешно отвязана"
      : "Карта успешно привязана"
    : isUnbind
    ? "Не удалось отвязать карту"
    : "Не удалось привязать карту";

  const subtitle = isLoading
    ? "Пожалуйста, подождите пару секунд."
    : isSuccess
    ? isUnbind
      ? "Карту больше нельзя использовать для быстрых платежей."
      : "Теперь вы можете создать поездку от физ.лица!."
    : "Проверьте данные и попробуйте ещё раз. Если проблема повторяется — напишите в поддержку.";

  return (
    <div className={styles.page}>
      <Head>
        <title>{title}</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div className={`ui-card ${styles.card}`} role="status" aria-live="polite">
        <StatusIcon variant={isLoading ? "loading" : isSuccess ? "success" : "error"} />

        <h1 className={styles.title}>{title}</h1>
        <p className={styles.subtitle}>{subtitle}</p>

        {!isLoading && !isSuccess && (ErrorCode || Message) && (
          <div className={styles.details}>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Код</span>
              <span className={styles.detailValue}>{ErrorCode || "—"}</span>
            </div>
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Сообщение</span>
              <span className={styles.detailValue}>{Message || "Неизвестная ошибка"}</span>
            </div>
          </div>
        )}

        <div className={styles.actions}>
          <button
            className={`ui-button ${styles.primaryButton}`}
            onClick={() => router.push("/dashboard?section=settings")}
          >
            Вернуться к настройкам
          </button>
        </div>

        {/* показываем подсказку только при ошибке */}
        {!isLoading && !isSuccess && (
          <p className={styles.hint}>
            Если вы уверены, что всё сделали правильно, но ошибка повторяется — отправьте в поддержку код
            из блока выше.
          </p>
        )}
      </div>
    </div>
  );
}
