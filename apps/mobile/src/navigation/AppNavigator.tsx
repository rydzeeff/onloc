import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import AuthScreen from '../screens/AuthScreen';
import TripsScreen from '../screens/TripsScreen';
import TripDetailsScreen from '../screens/TripDetailsScreen';
import MessagesScreen from '../screens/MessagesScreen';
import ProfileScreen from '../screens/ProfileScreen';
import { useAuth } from '../providers/AuthProvider';
import { env } from '../lib/env';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function TripsStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="TripsList" component={TripsScreen} options={{ title: 'Поездки' }} />
      <Stack.Screen name="TripDetails" component={TripDetailsScreen} options={{ title: 'Детали поездки' }} />
    </Stack.Navigator>
  );
}

function Tabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Trips" component={TripsStack} options={{ headerShown: false }} />
      <Tab.Screen name="Messages" component={MessagesScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  const { session, loading } = useAuth();
  if (loading) return null;

  return (
    <NavigationContainer
      linking={{
        prefixes: [`${env.scheme}://`],
        config: { screens: { Trips: 'trips', Messages: 'messages', Profile: 'profile' } }
      }}
    >
      {session ? <Tabs /> : <AuthScreen />}
    </NavigationContainer>
  );
}
