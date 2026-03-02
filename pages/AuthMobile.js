import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabaseClient';
import mobileStyles from '../styles/auth.mobile.module.css';
import { useAuth } from './_app';

export default function AuthMobile({ initialMode, router }) {
  const { setProcessing } = useAuth();
  const [mode, setMode] = useState(initialMode);
  const [step, setStep] = useState(1);

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [newPassword, setNewPassword] = useState('');
  const [newConfirmPassword, setNewConfirmPassword] = useState('');

  const [otp, setOtp] = useState('');
  const [callNumber, setCallNumber] = useState('');
  const [qrCodeUrl, setQrCodeUrl] = useState('');

  const [verificationSent, setVerificationSent] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verificationMethod, setVerificationMethod] = useState('');
  const [callId, setCallId] = useState(null);

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showNewConfirmPassword, setShowNewConfirmPassword] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(null);
  const initialViewportHeightRef = useRef(0);
  const compactActionLockRef = useRef(false);
  const compactControlSkipClickRef = useRef(false);

  const isPasswordComplex = (value) => /^(?=.*[A-ZА-ЯЁ])(?=.*\d).{8,}$/.test(value);
  const registerPasswordsMismatch = mode === 'register' && Boolean(password) && Boolean(confirmPassword) && password !== confirmPassword;
  const recoverPasswordsMismatch = mode === 'recover' && verified && Boolean(newPassword) && Boolean(newConfirmPassword) && newPassword !== newConfirmPassword;
  const registerPasswordWeak = mode === 'register' && Boolean(password) && !isPasswordComplex(password);
  const recoverPasswordWeak = mode === 'recover' && verified && Boolean(newPassword) && !isPasswordComplex(newPassword);

  // -----------------------------
  // Effects
  // -----------------------------
  useEffect(() => {
    const checkSession = async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) router.push('/trips');
    };
    checkSession();
  }, [router]);

  useEffect(() => {
    const { mode: queryMode, phone: queryPhone, method: queryMethod } = router.query;
    if (queryMode && ['login', 'register', 'recover'].includes(queryMode)) setMode(queryMode);
    if (queryPhone) setPhone(queryPhone.replace('7', ''));
    if (queryMethod) setVerificationMethod(queryMethod === 'otp' ? 'call' : queryMethod);
  }, [router.query]);

  // Подписка на verified для метода "call" (исходящий звонок)
  useEffect(() => {
    if (!verificationSent || !phone || verificationMethod !== 'call') return;

    const fullPhone = `7${phone}`;
    const channel = supabase
      .channel('temp_verifications')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'temp_verifications', filter: `phone=eq.${fullPhone}` },
        (payload) => {
          if (payload.new?.verified) {
            setVerified(true);

            // register: завершаем регистрацию (как на ПК: custom-auth login + setSession)
            if (mode === 'register') {
              completeRegistration();
              return;
            }

            // recover: переходим к вводу нового пароля
            if (mode === 'recover') {
              setStep(3);
            }
          }
        }
      )
      .subscribe((status, err) => {
        if (err) setError('Ошибка подписки на верификацию: ' + err.message);
      });

    return () => supabase.removeChannel(channel);
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

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const isInputElement = (element) => {
      if (!element || !(element instanceof HTMLElement)) return false;
      const tag = element.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA';
    };

    const updateKeyboardState = () => {
      const viewport = window.visualViewport;
      const currentHeight = viewport ? Math.round(viewport.height) : window.innerHeight;
      const baselineHeight = initialViewportHeightRef.current || currentHeight;
      const activeElement = document.activeElement;
      const hasFocusedInput = isInputElement(activeElement);
      const heightDiff = baselineHeight - currentHeight;

      if (currentHeight > initialViewportHeightRef.current) {
        initialViewportHeightRef.current = currentHeight;
      }

      setViewportHeight(currentHeight);
      setKeyboardOpen(hasFocusedInput && heightDiff > 120);
    };

    const handleFocusOut = () => setTimeout(updateKeyboardState, 80);

    initialViewportHeightRef.current = window.visualViewport
      ? Math.round(window.visualViewport.height)
      : window.innerHeight;

    updateKeyboardState();

    const viewport = window.visualViewport;
    window.addEventListener('resize', updateKeyboardState);
    viewport?.addEventListener('resize', updateKeyboardState);
    viewport?.addEventListener('scroll', updateKeyboardState);
    document.addEventListener('focusin', updateKeyboardState);
    document.addEventListener('focusout', handleFocusOut);

    return () => {
      window.removeEventListener('resize', updateKeyboardState);
      viewport?.removeEventListener('resize', updateKeyboardState);
      viewport?.removeEventListener('scroll', updateKeyboardState);
      document.removeEventListener('focusin', updateKeyboardState);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, []);

  // -----------------------------
  // Helpers
  // -----------------------------
  const customAuth = async (payload) => {
    const response = await fetch('/api/custom-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    let result = {};
    try {
      result = await response.json();
    } catch {
      result = {};
    }

    return { response, result };
  };

  function EyeIcon({ open = false }) {
    return (
      <svg className={mobileStyles.iconSvg} viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
        {!open && (
          <path d="M4 20L20 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        )}
      </svg>
    );
  }
  function PhoneIcon() {
    return (
      <svg className={mobileStyles.topNavIcon} viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M6.5 3.8h2.2c.6 0 1.1.4 1.2 1l.6 3c.1.6-.2 1.1-.7 1.4l-1.4.8a13.2 13.2 0 0 0 5.6 5.6l.8-1.4c.3-.5.9-.8 1.4-.7l3 .6c.6.1 1 .6 1 1.2v2.2c0 .7-.5 1.2-1.2 1.3-8.2.7-15-6.1-14.3-14.3.1-.7.6-1.2 1.3-1.2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  // -----------------------------
  // API Actions
  // -----------------------------
  const startVerification = async () => {
    setError('');
    if (!phone || phone.length !== 10 || !phone.startsWith('9')) {
      setError('Введите корректный номер телефона (10 цифр, начинается с 9)');
      return;
    }
    if ((mode === 'register') && (!password || !confirmPassword)) {
      setError('Введите пароль и подтверждение');
      return;
    }
    if (mode === 'register' && password !== confirmPassword) {
      setError('Пароли не совпадают');
      return;
    }
    if (mode === 'register' && !isPasswordComplex(password)) {
      setError('Пароль: минимум 8 символов, 1 заглавная буква и 1 цифра');
      return;
    }
    if ((mode === 'register' || mode === 'recover') && !verificationMethod) {
      setError('Выберите способ подтверждения');
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

      const { response, result } = await customAuth({
        phone: fullPhone,
        password: mode === 'register' ? password : undefined,
        mode: mode === 'recover' ? 'recover' : 'verify',
        verificationMethod,
      });

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

      setVerificationSent(true);
      setStep(2);
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

      const { response, result } = await customAuth({
        phone: fullPhone,
        password: mode === 'register' ? password : undefined,
        mode: mode === 'recover' ? 'recover' : 'verify',
        verificationMethod: 'otp',
      });

      if (!response.ok || !result.success) throw new Error(result.error || 'Ошибка повторной отправки');
      if (!result.callId) throw new Error('Не удалось подтвердить повторный звонок, попробуйте снова');

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
      const fullPhone = `7${phone}`;

      const { response, result } = await customAuth({
        phone: fullPhone,
        otp,
        password: mode === 'register' ? password : undefined,
        mode: mode === 'recover' ? 'verify_otp_recover' : 'verify_otp',
      });

      if (!response.ok || !result.success) throw new Error(result.error || 'Неверный код');

      // Важно: поведение как на ПК
      if (mode === 'register') {
        await supabase.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
        router.push(result.redirect);
      } else if (mode === 'recover') {
        setVerified(true);
        setStep(3);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProcessing(false);
    }
  };

  // Для метода "call" при регистрации: после verified=true делаем login через custom-auth и setSession (как на ПК)
  const completeRegistration = async () => {
    setLoading(true);
    setProcessing(true);
    setError('');
    try {
      const fullPhone = `7${phone}`;

      const { response, result } = await customAuth({ phone: fullPhone, password, mode: 'login' });

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

  // Login на мобилке как на ПК: custom-auth login -> setSession -> delay -> redirect
  const login = async () => {
    setError('');
    if (!phone || phone.length !== 10 || !phone.startsWith('9')) {
      setError('Введите корректный номер телефона (10 цифр, начинается с 9)');
      return;
    }
    if (!password) {
      setError('Введите пароль');
      return;
    }

    setLoading(true);
    setProcessing(true);
    try {
      const fullPhone = `7${phone}`;

      const { response, result } = await customAuth({ phone: fullPhone, password, mode: 'login' });

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

  // Recover: после recover_complete делаем login через custom-auth и setSession (как на ПК)
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
    if (!isPasswordComplex(newPassword)) {
      setError('Пароль: минимум 8 символов, 1 заглавная буква и 1 цифра');
      return;
    }

    setLoading(true);
    setProcessing(true);
    try {
      const fullPhone = `7${phone}`;

      const { response: recoverResponse, result: recoverResult } = await customAuth({
        phone: fullPhone,
        newPassword,
        mode: 'recover_complete',
      });

      if (!recoverResponse.ok || !recoverResult.success) throw new Error(recoverResult.error || 'Ошибка восстановления');

      const { response: loginResponse, result: loginResult } = await customAuth({
        phone: fullPhone,
        password: newPassword,
        mode: 'login',
      });

      if (!loginResponse.ok || !loginResult.success) throw new Error(loginResult.error || 'Ошибка входа после восстановления');

      await supabase.auth.setSession({ access_token: loginResult.access_token, refresh_token: loginResult.refresh_token });
      router.push(loginResult.redirect || '/trips');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProcessing(false);
    }
  };

  // -----------------------------
  // UI Actions
  // -----------------------------
  const handleSectionChange = (newMode) => {
    setMode(newMode);
    setStep(1);
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
    setShowPassword(false);
    setShowConfirmPassword(false);
    setShowNewPassword(false);
    setShowNewConfirmPassword(false);
    setError('');
    setResendCooldown(0);

    router.push(`/auth?mode=${newMode}`);
  };

  const goBackStep = () => {
    if (step === 2) {
      setStep(1);
      setVerificationSent(false);
      setVerified(false);
      setCallNumber('');
      setQrCodeUrl('');
      setOtp('');
      setCallId(null);
    } else if (step === 3) {
      setStep(2);
    }
  };

  const isRegisterStepOne = mode === 'register' && step === 1;
  const isRecoverPhoneStep = mode === 'recover' && step === 1;
  const isRecoverSetPasswordStep = mode === 'recover' && step === 3 && verified;
  const isLoginStep = mode === 'login';
  const isCompactKeyboardMode = keyboardOpen && (isRegisterStepOne || isLoginStep || isRecoverSetPasswordStep);
  const canContinueFromStepOne =
    !loading &&
    Boolean(phone) &&
    phone.length === 10 &&
    phone.startsWith('9') &&
    (mode !== 'register' || (Boolean(password) && Boolean(confirmPassword) && !registerPasswordsMismatch && !registerPasswordWeak));
  const canSubmitLogin = !loading && Boolean(phone) && phone.length === 10 && phone.startsWith('9') && Boolean(password);
  const canSubmitRecover = !loading && !recoverPasswordsMismatch && !recoverPasswordWeak && Boolean(newPassword) && Boolean(newConfirmPassword);
  const showRegisterStepOneButton = isRecoverPhoneStep || canContinueFromStepOne;
  const showRecoverSubmitButton = canSubmitRecover;
  const showCompactActionButton = isLoginStep || (isRegisterStepOne && canContinueFromStepOne) || (isRecoverSetPasswordStep && canSubmitRecover);

  const handleCompactPrimaryAction = () => {
    if (compactActionLockRef.current) return;
    compactActionLockRef.current = true;
    setTimeout(() => {
      compactActionLockRef.current = false;
    }, 250);

    if (isLoginStep) {
      login();
      return;
    }
    if (isRecoverSetPasswordStep) {
      recoverPassword();
      return;
    }
    setStep(2);
  };

  const handleCompactControlPointerDown = (event, action) => {
    if (!isCompactKeyboardMode) return;
    event.preventDefault();
    compactControlSkipClickRef.current = true;
    action();

    setTimeout(() => {
      compactControlSkipClickRef.current = false;
    }, 0);
  };

  const handleCompactControlClick = (event, action) => {
    if (compactControlSkipClickRef.current) {
      event.preventDefault();
      return;
    }
    action();
  };

  // -----------------------------
  // Render
  // -----------------------------
  return (
    <div
      className={`${mobileStyles.container} ${isCompactKeyboardMode ? mobileStyles.containerKeyboard : ''}`}
      style={viewportHeight ? { minHeight: `${viewportHeight}px` } : undefined}
    >
      <div className={`${mobileStyles.card} ${isCompactKeyboardMode ? mobileStyles.cardKeyboard : ''}`}>
        {!isCompactKeyboardMode && (
          <div className={mobileStyles.header}>
          <h1 className={mobileStyles.title}>
            {mode === 'login' ? 'Вход' : mode === 'register' ? 'Регистрация' : 'Восстановление'}
          </h1>
          <p className={mobileStyles.subtitle}>
            {mode === 'login'
              ? 'Войдите, чтобы продолжить'
              : mode === 'register'
              ? 'Создайте аккаунт для участия в поездках'
              : 'Подтвердите номер и задайте новый пароль'}
          </p>
          </div>
        )}

        {!isCompactKeyboardMode && <div className={mobileStyles.tabs}>
          <button
            className={`${mobileStyles.tabButton} ${mode === 'login' ? mobileStyles.activeTab : ''}`}
            onClick={() => handleSectionChange('login')}
            disabled={loading}
          >
            Вход
          </button>
          <button
            className={`${mobileStyles.tabButton} ${mode === 'register' ? mobileStyles.activeTab : ''}`}
            onClick={() => handleSectionChange('register')}
            disabled={loading}
          >
            Регистрация
          </button>
        </div>}

        {error && <div className={mobileStyles.error}>{error}</div>}

        <div className={mobileStyles.content}>
          {(step === 2 || step === 3) && (mode === 'register' || mode === 'recover') && (
            <button className={mobileStyles.backButton} onClick={goBackStep} disabled={loading}>
              ← Назад
            </button>
          )}

          {mode === 'login' && (
            <div className={mobileStyles.formContent}>
              <div className={`${mobileStyles.inputGroup} ${isCompactKeyboardMode ? mobileStyles.compactInputGroup : ''}`}>
                {!isCompactKeyboardMode && <label className={mobileStyles.label}>Телефон</label>}
                <div className={mobileStyles.phoneWrap}>
                  <span className={mobileStyles.phonePrefix}>+7</span>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    placeholder={isCompactKeyboardMode ? 'Телефон' : '9001234567'}
                    disabled={loading}
                    className={mobileStyles.phoneInput}
                  />
                </div>
              </div>

              <div className={`${mobileStyles.inputGroup} ${isCompactKeyboardMode ? mobileStyles.compactInputGroup : ''}`}>
                {!isCompactKeyboardMode && <label className={mobileStyles.label}>Пароль</label>}
                <div className={mobileStyles.passwordWrapper}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={isCompactKeyboardMode ? 'Пароль' : ''}
                    disabled={loading}
                    className={mobileStyles.input}
                  />
                  <button type="button" className={mobileStyles.eyeButton} onPointerDown={(e) => handleCompactControlPointerDown(e, () => setShowPassword((v) => !v))} onClick={(e) => handleCompactControlClick(e, () => setShowPassword((v) => !v))} aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"} title={showPassword ? "Скрыть пароль" : "Показать пароль"}>
                    <EyeIcon open={showPassword} />
                  </button>
                </div>
              </div>

              <button onClick={login} disabled={!canSubmitLogin} className={`${mobileStyles.actionButton} ${isCompactKeyboardMode ? mobileStyles.inlineNextHidden : ''}`}>
                {loading ? '...' : 'Войти'}
              </button>

              <button
                onPointerDown={(e) => handleCompactControlPointerDown(e, () => handleSectionChange('recover'))}
                onClick={(e) => handleCompactControlClick(e, () => handleSectionChange('recover'))}
                disabled={loading}
                className={mobileStyles.secondaryButton}
              >
                Забыли пароль?
              </button>
            </div>
          )}

          {(mode === 'register' || mode === 'recover') && step === 1 && (
            <div className={mobileStyles.formContent}>
              <div className={`${mobileStyles.inputGroup} ${isCompactKeyboardMode ? mobileStyles.compactInputGroup : ''}`}>
                {!isCompactKeyboardMode && <label className={mobileStyles.label}>Телефон</label>}
                <div className={mobileStyles.phoneWrap}>
                  <span className={mobileStyles.phonePrefix}>+7</span>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    placeholder={isCompactKeyboardMode ? 'Телефон' : '9001234567'}
                    disabled={loading}
                    className={mobileStyles.phoneInput}
                  />
                </div>
              </div>

              {mode === 'register' && (
                <>
                  <div className={`${mobileStyles.inputGroup} ${isCompactKeyboardMode ? mobileStyles.compactInputGroup : ''}`}>
                    {!isCompactKeyboardMode && <label className={mobileStyles.label}>Пароль</label>}
                    <div className={`${mobileStyles.passwordWrapper} ${(registerPasswordsMismatch || registerPasswordWeak) ? mobileStyles.passwordError : ''}`}>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={isCompactKeyboardMode ? 'Пароль' : ''}
                        disabled={loading}
                        className={mobileStyles.input}
                      />
                      <button type="button" className={mobileStyles.eyeButton} onPointerDown={(e) => handleCompactControlPointerDown(e, () => setShowPassword((v) => !v))} onClick={(e) => handleCompactControlClick(e, () => setShowPassword((v) => !v))} aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"} title={showPassword ? "Скрыть пароль" : "Показать пароль"}>
                        <EyeIcon open={showPassword} />
                      </button>
                    </div>
                  </div>
                  <div className={`${mobileStyles.inputGroup} ${isCompactKeyboardMode ? mobileStyles.compactInputGroup : ''}`}>
                    {!isCompactKeyboardMode && <label className={mobileStyles.label}>Подтвердите пароль</label>}
                    <div className={`${mobileStyles.passwordWrapper} ${registerPasswordsMismatch ? mobileStyles.passwordError : ''}`}>
                      <input
                        type={showConfirmPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder={isCompactKeyboardMode ? 'Подтвердите пароль' : ''}
                        disabled={loading}
                        className={mobileStyles.input}
                      />
                      <button type="button" className={mobileStyles.eyeButton} onPointerDown={(e) => handleCompactControlPointerDown(e, () => setShowConfirmPassword((v) => !v))} onClick={(e) => handleCompactControlClick(e, () => setShowConfirmPassword((v) => !v))} aria-label={showConfirmPassword ? "Скрыть пароль" : "Показать пароль"} title={showConfirmPassword ? "Скрыть пароль" : "Показать пароль"}>
                        <EyeIcon open={showConfirmPassword} />
                      </button>
                    </div>
                  </div>
                  {registerPasswordWeak && <div className={mobileStyles.inlineError}>Минимум 8 символов, 1 заглавная буква и 1 цифра</div>}
                  {registerPasswordsMismatch && <div className={mobileStyles.inlineError}>Пароли не совпадают</div>}
                </>
              )}

              <button
                onClick={() => setStep(2)}
                disabled={!canContinueFromStepOne}
                className={`${mobileStyles.actionButton} ${isCompactKeyboardMode ? mobileStyles.inlineNextHidden : ''} ${!showRegisterStepOneButton ? mobileStyles.actionButtonHidden : ''}`}
              >
                Далее
              </button>
            </div>
          )}

          {(mode === 'register' || mode === 'recover') && step === 2 && !verificationSent && (
            <div className={mobileStyles.formContent}>
              <div className={mobileStyles.methodTitle}>Выберите способ подтверждения</div>
              <div className={mobileStyles.methodOptions}>
                <div className={mobileStyles.optionsGrid}>
                  <label className={`${mobileStyles.optionCard} ${verificationMethod === 'call' ? mobileStyles.selected : ''}`}>
                    <input
                      type="radio"
                      name="verificationMethod"
                      value="call"
                      checked={verificationMethod === 'call'}
                      onChange={(e) => setVerificationMethod(e.target.value)}
                      disabled={loading}
                    />
                    <div className={mobileStyles.optionContent}>
                      <span className={mobileStyles.optionTitle}>Исходящий звонок</span>
                      <span className={mobileStyles.optionDescription}>
                        Позвоните на указанный номер для подтверждения.
                      </span>
                    </div>
                  </label>
                </div>
              </div>

              <button
                onClick={startVerification}
                disabled={loading || !verificationMethod || (mode === 'register' && (registerPasswordsMismatch || registerPasswordWeak))}
                className={mobileStyles.actionButton}
              >
                {loading ? '...' : 'Продолжить'}
              </button>
            </div>
          )}

          {step === 2 && verificationSent && (
            <div className={mobileStyles.formContent}>
              {verificationMethod === 'otp' && !verified ? (
                <>
                  <div className={mobileStyles.inputGroup}>
                    <label className={mobileStyles.label}>Введите последние 4 цифры номера вызова</label>
                    <input
                      type="text"
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      placeholder="1234"
                      maxLength={4}
                      disabled={loading}
                      className={mobileStyles.input}
                    />
                  </div>

                  <button onClick={verifyOtp} disabled={loading} className={mobileStyles.actionButton}>
                    {loading ? '...' : 'Подтвердить'}
                  </button>

                  <button
                    onClick={resendOtp}
                    disabled={loading || resendCooldown > 0}
                    className={mobileStyles.secondaryButton}
                  >
                    {resendCooldown > 0 ? `Повтор через ${resendCooldown} сек` : 'Отправить код повторно'}
                  </button>
                </>
) : verificationMethod === 'call' ? (
  <>
    <label className={mobileStyles.label}>Позвоните на номер:</label>

    {(() => {
      const raw = String(callNumber ?? "").trim();
      const digits = raw.replace(/[^\d]/g, ""); // только цифры

      // Что показываем: 7800... -> 8800...
      const displayNumber =
        digits.length === 11 && digits.startsWith("7")
          ? "8" + digits.slice(1)
          : digits;

      // По чему звоним: 8800... -> +7800...
      let dialDigits = digits;
      if (dialDigits.length === 11 && dialDigits.startsWith("8")) {
        dialDigits = "7" + dialDigits.slice(1);
      }

      const telHref = `tel:+${dialDigits}`;

      return (
        <div className={mobileStyles.callRow}>
          <a href={telHref} className={mobileStyles.callLink}>
            {displayNumber}
          </a>

          <a
            href={telHref}
            className={mobileStyles.callIconButton}
            aria-label="Позвонить"
            title="Позвонить"
          >
            <PhoneIcon />
          </a>
        </div>
      );
    })()}
  </>
) : null}
            </div>
          )}

          {step === 3 && mode === 'recover' && verified && (
            <div className={mobileStyles.formContent}>
              <div className={`${mobileStyles.inputGroup} ${isCompactKeyboardMode ? mobileStyles.compactInputGroup : ''}`}>
                {!isCompactKeyboardMode && <label className={mobileStyles.label}>Новый пароль</label>}
                <div className={`${mobileStyles.passwordWrapper} ${(recoverPasswordsMismatch || recoverPasswordWeak) ? mobileStyles.passwordError : ''}`}>
                  <input
                    type={showNewPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={isCompactKeyboardMode ? 'Новый пароль' : ''}
                    disabled={loading}
                    className={mobileStyles.input}
                  />
                  <button type="button" className={mobileStyles.eyeButton} onPointerDown={(e) => handleCompactControlPointerDown(e, () => setShowNewPassword((v) => !v))} onClick={(e) => handleCompactControlClick(e, () => setShowNewPassword((v) => !v))} aria-label={showNewPassword ? "Скрыть пароль" : "Показать пароль"} title={showNewPassword ? "Скрыть пароль" : "Показать пароль"}>
                    <EyeIcon open={showNewPassword} />
                  </button>
                </div>
              </div>

              <div className={`${mobileStyles.inputGroup} ${isCompactKeyboardMode ? mobileStyles.compactInputGroup : ''}`}>
                {!isCompactKeyboardMode && <label className={mobileStyles.label}>Подтвердите пароль</label>}
                <div className={`${mobileStyles.passwordWrapper} ${recoverPasswordsMismatch ? mobileStyles.passwordError : ''}`}>
                  <input
                    type={showNewConfirmPassword ? 'text' : 'password'}
                    value={newConfirmPassword}
                    onChange={(e) => setNewConfirmPassword(e.target.value)}
                    placeholder={isCompactKeyboardMode ? 'Подтвердите пароль' : ''}
                    disabled={loading}
                    className={mobileStyles.input}
                  />
                  <button type="button" className={mobileStyles.eyeButton} onPointerDown={(e) => handleCompactControlPointerDown(e, () => setShowNewConfirmPassword((v) => !v))} onClick={(e) => handleCompactControlClick(e, () => setShowNewConfirmPassword((v) => !v))} aria-label={showNewConfirmPassword ? "Скрыть пароль" : "Показать пароль"} title={showNewConfirmPassword ? "Скрыть пароль" : "Показать пароль"}>
                    <EyeIcon open={showNewConfirmPassword} />
                  </button>
                </div>
              </div>

              {recoverPasswordWeak && <div className={mobileStyles.inlineError}>Минимум 8 символов, 1 заглавная буква и 1 цифра</div>}
              {recoverPasswordsMismatch && <div className={mobileStyles.inlineError}>Пароли не совпадают</div>}

              <button onClick={recoverPassword} disabled={!canSubmitRecover} className={`${mobileStyles.actionButton} ${isCompactKeyboardMode ? mobileStyles.inlineNextHidden : ''} ${!showRecoverSubmitButton ? mobileStyles.actionButtonHidden : ''}`}>
                {loading ? '...' : 'Сменить пароль'}
              </button>
            </div>
          )}
        </div>
      </div>

      {isCompactKeyboardMode && showCompactActionButton && (
        <button
          onPointerDown={handleCompactPrimaryAction}
          onClick={handleCompactPrimaryAction}
          disabled={isLoginStep ? !canSubmitLogin : isRecoverSetPasswordStep ? !canSubmitRecover : !canContinueFromStepOne}
          className={`${mobileStyles.actionButton} ${mobileStyles.keyboardNextButton}`}
        >
          {isLoginStep ? 'Войти' : isRecoverSetPasswordStep ? 'Сменить пароль' : 'Далее'}
        </button>
      )}
    </div>
  );
}
