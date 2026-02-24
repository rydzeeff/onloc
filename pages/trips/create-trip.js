import { useAuth } from '../_app';
import CreateTripPC from './CreateTripPC';
import CreateTripMobile from './CreateTripMobile';

export default function CreateTrip({ toLocation, mainContentRef }) {
  const { isMobile } = useAuth();

  return isMobile ? (
    <CreateTripMobile toLocation={toLocation} mainContentRef={mainContentRef} />
  ) : (
    <CreateTripPC toLocation={toLocation} />
  );
}

export async function getServerSideProps(context) {
  const { to_location } = context.query;
  return { props: { toLocation: to_location || null } };
}