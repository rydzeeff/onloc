import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import pcStyles from '../styles/auth.pc.module.css';
import { useAuth } from './_app';

export default function AuthPC({ initialMode, router }) {
  const { setProcessing } = useAuth();
  const [mode, setMode] = useState(initialMode);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newConfirmPassword, setNewConfirmPassword] = useState('');
  const [callNumber, setCallNumber] = useState('');
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [otp, setOtp] = useState('');
  const [verificationSent, setVerificationSent] = useState(false);
  const [verified, setVerified] = useState(false);
  const [callFadeOut, setCallFadeOut] = useState(false);
  const [verificationMethod, setVerificationMethod] = useState('');
  const [callId, setCallId] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    setProcessing(true);
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) router.push('/trips');
      setProcessing(false);
    };
    checkSession();
  }, [router, setProcessing]);

useEffect(() => {
  const step = router.query.step;

  // Если пользователь нажал "Назад" и step пропал — возвращаемся к форме ввода
  if (step !== 'verify' && verificationSent) {
    resetVerificationStep();
  }
}, [router.query.step, verificationSent]);


  useEffect(() => {
    const { mode: queryMode, phone: queryPhone, method: queryMethod } = router.query;
    if (queryMode && ['login', 'register', 'recover'].includes(queryMode)) setMode(queryMode);
    if (queryPhone) setPhone(String(queryPhone).replace(/^7/, ''));
if (queryMethod) setVerificationMethod(queryMethod);
  }, [router.query]);

  useEffect(() => {
    if (!verificationSent || !phone || verificationMethod !== 'call') return;

    const fullPhone = `7${phone}`;
    let timerId;

    const channel = supabase
      .channel('temp_verifications')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'temp_verifications', filter: `phone=eq.${fullPhone}` },
        (payload) => {
          if (payload.new.verified) {
            setCallFadeOut(true);
            timerId = setTimeout(() => {
              setVerified(true);
            }, 250);

            if (mode === 'register') completeRegistration();
          }
        }
      )
      .subscribe((status, err) => {
        if (err) setError('Ошибка подписки на верификацию: ' + err.message);
      });

    return () => {
      if (timerId) clearTimeout(timerId);
      supabase.removeChannel(channel);
    };
  }, [verificationSent, phone, mode, verificationMethod]);

  useEffect(() => {
    if (resendCooldown > 0) {
      const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCooldown]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  const handlePhoneChange = (e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10));

  const startVerification = async () => {
    setError('');
    if (!phone || phone.length !== 10 || !phone.startsWith('9')) {
      setError('Введите корректный номер телефона (10 цифр, начинается с 9)');
      return;
    }
    if (mode === 'register') {
      if (!password || !confirmPassword) {
        setError('Введите пароль и подтверждение');
        return;
      }
      if (password !== confirmPassword) {
        setError('Пароли не совпадают');
        return;
      }
      if (password.length < 8) {
        setError('Пароль должен быть не менее 8 символов');
        return;
      }
    }
    if (mode !== 'login' && !verificationMethod) {
      setError('Выберите метод верификации');
      return;
    }
    if (verificationMethod === 'otp') {
      setError('Верификация по входящему звонку отключена');
      return;
    }

    setLoading(true);
    setProcessing(true);
    try {
      const fullPhone = `7${phone}`;
      const response = await fetch('/api/custom-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone: fullPhone,
          password: mode === 'register' ? password : undefined,
          mode: mode === 'recover' ? 'recover' : 'verify',
          verificationMethod,
        }),
      });

      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Ошибка отправки запроса');

      if (verificationMethod === 'otp') {
        if (!result.callId) throw new Error('Не удалось подтвердить отправку звонка, попробуйте снова');
        setCallId(result.callId);
        setOtp('');
        setResendCooldown(60);
      } else {
        setCallNumber(result.callNumber);
        setQrCodeUrl(result.qrCodeUrl);
      }

setCallFadeOut(false);

await router.push(
  `/auth?mode=${mode}&phone=7${phone}&method=${verificationMethod}&step=verify`,
  undefined,
  { shallow: true }
);

setVerificationSent(true);

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProcessing(false);
    }
  };

  const resendOtp = async () => {
    setError('');
    if (!phone || phone.length !== 10 || !phone.startsWith('9')) {
      setError('Введите корректный номер телефона (10 цифр, начинается с 9)');
      return;
    }
    setLoading(true);
    setProcessing(true);
    try {
      const fullPhone = `7${phone}`;
      const response = await fetch('/api/custom-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone: fullPhone,
          password: mode === 'register' ? password : undefined,
          mode: mode === 'recover' ? 'recover' : 'verify',
          verificationMethod: 'otp',
        }),
      });

      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Не удалось отправить код повторно');
      if (!result.callId) throw new Error('Не удалось подтвердить отправку звонка, попробуйте снова');

      setCallId(result.callId);
      setOtp('');
      setResendCooldown(60);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProcessing(false);
    }
  };

  const verifyOtp = async () => {
    setLoading(true);
    setProcessing(true);
    setError('');

    if (!otp || otp.length !== 4) {
      setError('Введите корректный код (4 цифры)');
      setLoading(false);
      setProcessing(false);
      return;
    }

    try {
      const response = await fetch('/api/custom-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone: `7${phone}`,
          otp,
          password: mode === 'register' ? password : undefined,
          mode: mode === 'recover' ? 'verify_otp_recover' : 'verify_otp',
        }),
      });

      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Неверный код');

      if (mode === 'register') {
        await supabase.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
        router.push(result.redirect);
      } else if (mode === 'recover') {
        setVerified(true);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProcessing(false);
    }
  };

  const completeRegistration = async () => {
    setLoading(true);
    setProcessing(true);
    try {
      const response = await fetch('/api/custom-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phone: `7${phone}`, password, mode: 'login' }),
      });

      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Ошибка завершения регистрации');

      await supabase.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
      router.push(result.redirect);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProcessing(false);
    }
  };

  const login = async () => {
    setLoading(true);
    setProcessing(true);
    setError('');

    if (!phone || phone.length !== 10 || !phone.startsWith('9')) {
      setError('Введите корректный номер телефона (10 цифр, начинается с 9)');
      setLoading(false);
      setProcessing(false);
      return;
    }
    if (!password) {
      setError('Введите пароль');
      setLoading(false);
      setProcessing(false);
      return;
    }

    try {
      const response = await fetch('/api/custom-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phone: `7${phone}`, password, mode: 'login' }),
      });

      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Ошибка входа');

      await supabase.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
      await new Promise(resolve => setTimeout(resolve, 500));
      router.push(result.redirect);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProcessing(false);
    }
  };

  const recoverPassword = async () => {
    setError('');

    if (!newPassword || !newConfirmPassword) {
      setError('Введите новый пароль и подтверждение');
      return;
    }
    if (newPassword !== newConfirmPassword) {
      setError('Пароли не совпадают');
      return;
    }
    if (newPassword.length < 8) {
      setError('Пароль должен быть не менее 8 символов');
      return;
    }

    setLoading(true);
    setProcessing(true);
    try {
      const fullPhone = `7${phone}`;
      const recoverResponse = await fetch('/api/custom-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phone: fullPhone, newPassword, mode: 'recover_complete' }),
      });

      const recoverResult = await recoverResponse.json();
      if (!recoverResponse.ok || !recoverResult.success) throw new Error(recoverResult.error || 'Ошибка восстановления');

      const loginResponse = await fetch('/api/custom-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ phone: fullPhone, password: newPassword, mode: 'login' }),
      });

      const loginResult = await loginResponse.json();
      if (!loginResponse.ok || !loginResult.success) throw new Error(loginResult.error || 'Ошибка входа после восстановления');

      await supabase.auth.setSession({ access_token: loginResult.access_token, refresh_token: loginResult.refresh_token });
      router.push('/trips');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProcessing(false);
    }
  };

const resetVerificationStep = () => {
  setVerificationSent(false);
  setVerified(false);

  setCallNumber('');
  setQrCodeUrl('');
  setOtp('');
  setCallId(null);

  setCallFadeOut(false);
  setResendCooldown(0);
  setError('');
};


  const handleSectionChange = (newMode) => {
    setMode(newMode);
    setVerificationSent(false);
    setVerified(false);
    setCallNumber('');
    setQrCodeUrl('');
    setOtp('');
    setVerificationMethod('');
    setCallId(null);
    setPassword('');
    setConfirmPassword('');
    setNewPassword('');
    setNewConfirmPassword('');
    setError('');
    setResendCooldown(0);
    setCallFadeOut(false);
    router.push(`/auth?mode=${newMode}&phone=7${phone}`, undefined, { shallow: true });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (loading) return;

    if (!verificationSent) {
      if (mode === 'login') login();
      else startVerification(); // register / recover
    } else {
      if (verificationMethod === 'otp' && !verified) verifyOtp();
      else if (mode === 'recover' && verified) recoverPassword();
    }
  };

  return (
    <div className={pcStyles.container}>
      <div className={pcStyles.card}>
        <h1 className={pcStyles.header}>
          {mode === 'login' ? 'Вход' : mode === 'register' ? 'Регистрация' : 'Восстановление пароля'}
        </h1>

        {error && <div className={pcStyles.error}>{error}</div>}

        <form className={pcStyles.form} onSubmit={handleSubmit}>
          {!verificationSent ? (
            <div className={pcStyles.formContent}>
              <div className={pcStyles.inputGroup}>
                <label className={pcStyles.label}>Номер телефона</label>
                <div className={pcStyles.phoneInputWrapper}>
                  <span className={pcStyles.phonePrefix}>+7</span>
                  <input
                    type="text"
                    value={phone}
                    onChange={handlePhoneChange}
                    placeholder="9123456789"
                    maxLength={10}
                    disabled={loading}
                    className={pcStyles.phoneInput}
                  />
                </div>
              </div>

              {mode !== 'recover' && (
                <>
                  <div className={pcStyles.inputGroup}>
                    <label className={pcStyles.label}>Пароль</label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loading}
                      className={pcStyles.input}
                    />
                  </div>

                  {mode === 'register' && (
                    <div className={pcStyles.inputGroup}>
                      <label className={pcStyles.label}>Подтверждение пароля</label>
                      <input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        disabled={loading}
                        className={pcStyles.input}
                      />
                    </div>
                  )}
                </>
              )}

              {(mode === 'register' || mode === 'recover') && (
                <div className={pcStyles.verificationOptions}>
                  <h3 className={pcStyles.verificationHeader}>Как вы хотите пройти верификацию?</h3>
                  <div className={pcStyles.optionCards}>
                    <label className={`${pcStyles.optionCard} ${verificationMethod === 'call' ? pcStyles.selected : ''}`}>
                      <input
                        type="radio"
                        name="verificationMethod"
                        value="call"
                        checked={verificationMethod === 'call'}
                        onChange={(e) => setVerificationMethod(e.target.value)}
                        disabled={loading}
                      />
                      <div className={pcStyles.optionContent}>
                        <span className={pcStyles.optionTitle}>Исходящий звонок</span>
                        <span className={pcStyles.optionDescription}>Позвоните на указанный номер для подтверждения.</span>
                      </div>
                    </label>
                  </div>
                </div>
              )}

              <div className={pcStyles.buttonWrapper}>
                <button type="submit" disabled={loading} className={pcStyles.actionButton}>
                  {loading ? '...' : mode === 'login' ? 'Войти' : mode === 'register' ? 'Верификация' : 'Восстановить'}
                </button>
              </div>
            </div>
          ) : (
            <div className={pcStyles.formContent}>
              {verificationMethod === 'otp' && !verified ? (
                <>
                  <div className={pcStyles.inputGroup}>
                    <label className={pcStyles.label}>Введите последние 4 цифры номера вызова</label>
                    <input
                      type="text"
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      placeholder="1234"
                      maxLength={4}
                      disabled={loading}
                      className={pcStyles.input}
                    />
                  </div>

                  <button type="submit" disabled={loading} className={pcStyles.actionButton}>
                    {loading ? '...' : 'Подтвердить'}
                  </button>

                  <button
                    type="button"
                    onClick={resendOtp}
                    disabled={loading || resendCooldown > 0}
                    className={pcStyles.secondaryButton}
                  >
                    {resendCooldown > 0 ? `Повтор через ${resendCooldown} сек` : 'Отправить код повторно'}
                  </button>
                </>
              ) : verificationMethod === 'call' && !verified ? (
                <div className={`${pcStyles.callBlock} ${callFadeOut ? pcStyles.fadeOut : pcStyles.fadeIn}`}>
                  <label className={pcStyles.label}>Позвоните на номер:</label>

                  {(() => {
                    const digits = String(callNumber ?? "").replace(/[^\d]/g, "");
                    const displayNumber =
                      digits.length === 11 && digits.startsWith("7")
                        ? "8" + digits.slice(1)
                        : digits;

                    return <div className={pcStyles.callNumber}>{displayNumber}</div>;
                  })()}

                  {qrCodeUrl && (
                    <div>
                      <p className={pcStyles.qrText}>Или отсканируйте QR-код:</p>
                      <img src={qrCodeUrl} alt="QR Code" className={pcStyles.qrImageSmall} />
                    </div>
                  )}

<button
  type="button"
  onClick={() => {
    resetVerificationStep();

    // Убираем step=verify из URL, чтобы логика back/forward была правильной
   router.replace(`/auth?mode=${mode}&phone=7${phone}`, undefined, { shallow: true });
  }}
  className={pcStyles.secondaryButton}
>
  Изменить номер
</button>

                </div>
              ) : null}

              {mode === 'recover' && verified && (
                <div className={`${pcStyles.formContent} ${pcStyles.fadeIn}`}>
                  <div className={pcStyles.inputGroup}>
                    <label className={pcStyles.label}>Новый пароль</label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      disabled={loading}
                      className={pcStyles.input}
                    />
                  </div>

                  <div className={pcStyles.inputGroup}>
                    <label className={pcStyles.label}>Подтвердите пароль</label>
                    <input
                      type="password"
                      value={newConfirmPassword}
                      onChange={(e) => setNewConfirmPassword(e.target.value)}
                      disabled={loading}
                      className={pcStyles.input}
                    />
                  </div>

                  <div className={pcStyles.buttonWrapper}>
                    <button type="submit" disabled={loading} className={pcStyles.actionButton}>
                      {loading ? '...' : 'Обновить пароль'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className={pcStyles.linkWrapper}>
            {mode === 'login' ? (
              <>
                <span className={pcStyles.linkTextWrapper}>
                  Нет аккаунта?{' '}
                  <a onClick={() => handleSectionChange('register')} className={pcStyles.linkText}>
                    Зарегистрироваться
                  </a>
                </span>
                <span className={pcStyles.linkTextWrapper}>
                  Забыли пароль?{' '}
                  <a onClick={() => handleSectionChange('recover')} className={pcStyles.linkText}>
                    Восстановить
                  </a>
                </span>
              </>
            ) : mode === 'register' ? (
              <span className={pcStyles.linkTextWrapper}>
                Уже есть аккаунт?{' '}
                <a onClick={() => handleSectionChange('login')} className={pcStyles.linkText}>
                  Войти
                </a>
              </span>
            ) : (
              <span className={pcStyles.linkTextWrapper}>
                Вернуться ко входу?{' '}
                <a onClick={() => handleSectionChange('login')} className={pcStyles.linkText}>
                  Войти
                </a>
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
