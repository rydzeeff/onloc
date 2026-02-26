import React, { useState } from 'react';
import { Button, ScrollView, Text, View } from 'react-native';
import { Field } from '../components/Field';
import { applySession, customAuth } from '../lib/auth';

export default function AuthScreen() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>('login');
  const [verificationMethod, setVerificationMethod] = useState<'call' | 'otp'>('call');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'base' | 'verify' | 'recover'>('base');
  const [message, setMessage] = useState('');

  const fullPhone = `7${phone}`;

  const login = async () => {
    const result = await customAuth({ phone: fullPhone, password, mode: 'login' });
    await applySession(result.access_token, result.refresh_token);
  };

  const startFlow = async () => {
    const result = await customAuth({
      phone: fullPhone,
      password: mode === 'register' ? password : undefined,
      mode: mode === 'recover' ? 'recover' : 'verify',
      verificationMethod
    });
    setMessage(result.callNumber ? `Позвоните на ${result.callNumber}` : 'Код отправлен');
    setStep('verify');
  };

  const verifyOtp = async () => {
    const result = await customAuth({
      phone: fullPhone,
      otp,
      password: mode === 'register' ? password : undefined,
      mode: mode === 'recover' ? 'verify_otp_recover' : 'verify_otp'
    });

    if (mode === 'register') {
      await applySession(result.access_token, result.refresh_token);
    } else {
      setStep('recover');
    }
  };

  const recoverComplete = async () => {
    await customAuth({ phone: fullPhone, newPassword: password, mode: 'recover_complete' });
    await login();
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: '700', marginBottom: 12 }}>Onloc Auth</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <Button title="Login" onPress={() => { setMode('login'); setStep('base'); }} />
        <Button title="Register" onPress={() => { setMode('register'); setStep('base'); }} />
        <Button title="Recover" onPress={() => { setMode('recover'); setStep('base'); }} />
      </View>

      <Field label="Телефон (+7)" keyboardType="phone-pad" value={phone} onChangeText={(v) => setPhone(v.replace(/\D/g, '').slice(0, 10))} />
      <Field label={mode === 'recover' && step === 'recover' ? 'Новый пароль' : 'Пароль'} secureTextEntry value={password} onChangeText={setPassword} />

      {step === 'verify' && <Field label="OTP (если используете otp)" keyboardType="number-pad" value={otp} onChangeText={setOtp} />}

      {mode !== 'login' && step === 'base' && (
        <View style={{ marginBottom: 8 }}>
          <Button title={`Метод: ${verificationMethod}`} onPress={() => setVerificationMethod((m) => (m === 'call' ? 'otp' : 'call'))} />
        </View>
      )}

      {mode === 'login' && <Button title="Войти" onPress={login} />}
      {mode !== 'login' && step === 'base' && <Button title="Начать верификацию" onPress={startFlow} />}
      {step === 'verify' && <Button title="Подтвердить" onPress={verifyOtp} />}
      {mode === 'recover' && step === 'recover' && <Button title="Сменить пароль" onPress={recoverComplete} />}

      {!!message && <Text style={{ marginTop: 12 }}>{message}</Text>}
    </ScrollView>
  );
}
