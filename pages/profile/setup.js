import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../_app';
import ProfileSetupPC from './ProfileSetupPC';
import ProfileSetupMobile from './ProfileSetupMobile';

export default function ProfileSetup() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [isMobile, setIsMobile] = useState(null);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  if (authLoading || !user || isMobile === null) {
    return <div>Loading...</div>;
  }

  return isMobile ? (
    <ProfileSetupMobile user={user} router={router} />
  ) : (
    <ProfileSetupPC user={user} router={router} />
  );
}