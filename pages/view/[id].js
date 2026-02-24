// /pages/trip-view/[id].js
import { useAuth } from '../_app';
import TripViewPagePC from './TripViewPagePC';
import TripViewPageMobile from './TripViewPageMobile';

export default function TripViewPage() {
  const { isMobile } = useAuth();
  return isMobile ? <TripViewPageMobile /> : <TripViewPagePC />;
}

export async function getServerSideProps(context) {
  const { id } = context.params;
  return { props: { id } };
}
