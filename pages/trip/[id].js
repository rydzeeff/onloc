import { useAuth } from '../_app';
import TripDetailsPagePC from './TripDetailsPagePC';
import TripDetailsPageMobile from './TripDetailsPageMobile';

export default function TripDetailsPage() {
  const { isMobile } = useAuth();

  return isMobile ? <TripDetailsPageMobile /> : <TripDetailsPagePC />;
}

export async function getServerSideProps(context) {
  const { id } = context.params;
  return { props: { id } };
}