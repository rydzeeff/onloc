import { useAuth } from '../_app';
import EditTripPC from './EditTripPC';
import EditTripMobile from './EditTripMobile';

export default function EditTrip({ tripId, returnTo }) {
  const { isMobile } = useAuth();

  return isMobile ? (
    <EditTripMobile tripId={tripId} returnTo={returnTo} />
  ) : (
    <EditTripPC tripId={tripId} returnTo={returnTo} />
  );
}

export async function getServerSideProps(context) {
  const { tripId, returnTo } = context.query || {};
  return {
    props: {
      tripId: typeof tripId === 'string' ? tripId : null,
      returnTo: typeof returnTo === 'string' ? returnTo : null,
    },
  };
}
