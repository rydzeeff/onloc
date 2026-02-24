import React from 'react';
import styles from '../styles/create-trip.module.css';

export default function FeedbackButton({ onClick }) {
  return (
    <button className={styles.feedbackButton} type="button" onClick={onClick}>
      <img src="/feedback-icon.png" className={styles.feedbackButtonIcon} alt="feedback" />
      <span>Choose Location</span>
    </button>
  );
}
