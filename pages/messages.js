import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth } from './_app';
import DesktopMessagesPage from "./DesktopMessagesPage";
import MobileMessagesPage from "./MobileMessagesPage";

export default function MessagesPage({ user, triggerAnimation, onChatOpen }) {
  const router = useRouter();
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;

  useEffect(() => {
    if (!user) {
      router.push("/auth/sign-in");
    }
  }, [user, router]);

  if (!user) return null;

  return isMobile ? (
    <MobileMessagesPage user={user} triggerAnimation={triggerAnimation} onChatOpen={onChatOpen} />
  ) : (
    <DesktopMessagesPage user={user} triggerAnimation={triggerAnimation} />
  );
}