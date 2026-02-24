import { useState, useRef, useEffect } from 'react';
import dynamic from 'next/dynamic';
import styles from '../styles/avatar-editor.module.css';

const Avatar = dynamic(() => import('react-avatar-edit').then(mod => mod.default), { ssr: false });

const AvatarEditor = ({ user, avatarUrl, updateAvatarUrl, supabase, type = 'individual', onAvatarClick, canEditAvatar = true }) => {
  const [preview, setPreview] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [message, setMessage] = useState(null);
  const editorRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showEditor && editorRef.current && !editorRef.current.contains(event.target)) {
        setShowEditor(false);
        setPreview(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showEditor]);

  const compressImage = (file, maxSize, callback) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.src = e.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        let width = img.width;
        let height = img.height;
        const maxDimension = 1024;
        if (width > height && width > maxDimension) {
          height *= maxDimension / width;
          width = maxDimension;
        } else if (height > maxDimension) {
          width *= maxDimension / height;
          height = maxDimension;
        }
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            const compressedFile = new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() });
            if (compressedFile.size > maxSize) {
              canvas.toBlob(
                (smallerBlob) => {
                  const smallerFile = new File([smallerBlob], file.name, { type: 'image/jpeg', lastModified: Date.now() });
                  callback(smallerFile);
                },
                'image/jpeg',
                0.7
              );
            } else {
              callback(compressedFile);
            }
          },
          'image/jpeg',
          0.85
        );
      };
    };
    reader.readAsDataURL(file);
  };

  const onBeforeFileLoad = (elem) => {
    const file = elem.target.files[0];
    if (file.size > 5 * 1024 * 1024) {
      compressImage(file, 5 * 1024 * 1024, (compressedFile) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(compressedFile);
        elem.target.files = dataTransfer.files;
      });
    }
  };

  const onCrop = (preview) => {
    setPreview(preview);
  };

  const onClose = () => {
    setPreview(null);
    setShowEditor(false);
  };

  const handleSaveAvatar = async () => {
    if (!preview) return;

    // safety: иногда компонент могут вызвать без нужных пропсов
    if (!supabase || !user?.id) {
      setMessage('Нет активной сессии. Перезайдите в аккаунт.');
      setTimeout(() => setMessage(null), 3000);
      return;
    }

    setIsLoading(true);

    const bucket = type === 'individual' ? 'avatars' : 'avatar-company';

    const blob = await fetch(preview).then((res) => res.blob());
    const timestamp = new Date().getTime();
    const fileName = `avatar-${timestamp}.jpg`;
    const file = new File([blob], fileName, { type: 'image/jpeg' });

    const { data: existingFiles, error: listError } = await supabase.storage
      .from(bucket)
      .list(user.id, { limit: 100 });

    if (listError) {
      setMessage('Ошибка при загрузке аватара');
      setTimeout(() => setMessage(null), 3000);
      setIsLoading(false);
      return;
    }

    if (existingFiles && existingFiles.length > 0) {
      const filesToRemove = existingFiles.map((file) => `${user.id}/${file.name}`);
      const { error: removeError } = await supabase.storage
        .from(bucket)
        .remove(filesToRemove);
      if (removeError) {
        setMessage('Ошибка при удалении старого аватара');
        setTimeout(() => setMessage(null), 3000);
        setIsLoading(false);
        return;
      }
    }

    const uploadPath = `${user.id}/${fileName}`;
    const { data, error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(uploadPath, file, { upsert: true });

    if (uploadError) {
      setMessage(`Ошибка загрузки аватара: ${uploadError.message}`);
      setTimeout(() => setMessage(null), 3000);
      setIsLoading(false);
      return;
    }

    const { publicUrl } = supabase.storage.from(bucket).getPublicUrl(uploadPath).data;

    let updateError = null;

    if (type === 'individual') {
      const res = await supabase
        .from('profiles')
        .upsert({ user_id: user.id, avatar_url: publicUrl }, { onConflict: 'user_id' });
      updateError = res.error;
    } else {
      // company: НЕ upsert (у mycompany есть NOT NULL поля name/inn и т.д.)
      // поэтому ищем активную компанию и обновляем только avatar_url
      const { data: activeCompany, error: fetchErr } = await supabase
        .from('mycompany')
        .select('company_id')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fetchErr) {
        updateError = fetchErr;
      } else if (!activeCompany?.company_id) {
        updateError = new Error('Сначала сохраните организацию (вкладка «Компании»), затем загрузите аватар.');
      } else {
        const upd = await supabase
          .from('mycompany')
          .update({ avatar_url: publicUrl })
          .eq('company_id', activeCompany.company_id);
        updateError = upd.error;
      }
    }

    if (updateError) {
      setMessage(`Ошибка сохранения URL аватара: ${updateError.message}`);
      setTimeout(() => setMessage(null), 3000);
    } else {
      updateAvatarUrl(publicUrl);
      setPreview(null);
      setShowEditor(false);
      setMessage('Аватар успешно обновлён');
      setTimeout(() => setMessage(null), 3000);
    }
    setIsLoading(false);
  };

  const handleAvatarClick = () => {
    onAvatarClick?.();
    if (canEditAvatar) {
      setShowEditor(true);
    }
  };

  return (
    <div className={styles.avatarWrapper}>
      <div className={styles.avatarContainer} onClick={handleAvatarClick}>
        {isLoading ? (
          <div>Loading...</div>
        ) : (
          <img src={avatarUrl} alt={`Аватар ${type === 'individual' ? 'физ. лица' : 'компании'}`} />
        )}
        <span className={styles.avatarPlus}>✕</span>
      </div>
      {showEditor && (
        <div className={styles.filePicker} ref={editorRef}>
          <Avatar
            width={500}
            imageWidth={500}
            onCrop={onCrop}
            onClose={onClose}
            onBeforeFileLoad={onBeforeFileLoad}
            exportSize={150}
            exportAsSquare={false}
            cropRadius={75}
            label="Выберите фото"
          />
          {preview && (
            <div className={styles.cropButtons}>
              <button onClick={handleSaveAvatar}>Сохранить</button>
              <button onClick={onClose}>Отменить</button>
            </div>
          )}
        </div>
      )}
      {message && <div className={styles.toast}>{message}</div>}
    </div>
  );
};

export default AvatarEditor;
