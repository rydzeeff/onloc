// components/FiltersPC.js
import { useState, useEffect, useRef } from 'react';
import DatePicker, { registerLocale } from 'react-datepicker';
import ru from 'date-fns/locale/ru';
import 'react-datepicker/dist/react-datepicker.css';
import styles from '../styles/filters.pc.module.css';

registerLocale('ru', ru);

export default function FiltersPC({
  filters,
  setFilters,
  applyFilter,
  removeFilter,
  leisureTypeLabels,
  difficultyLabels,
  today,
  twoWeeksLater,
  setSelectedTripId,
  onMapClick
}) {
  const [activeFilter, setActiveFilter] = useState(null);
  const filtersRef = useRef(null);

  // держим актуальные filters, чтобы применять фильтр сразу (без ожидания setState)
  const latestFiltersRef = useRef(filters);
  const priceDebounceRef = useRef(null);

  useEffect(() => {
    latestFiltersRef.current = filters;
  }, [filters]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (filtersRef.current && !filtersRef.current.contains(e.target)) {
        setActiveFilter(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      try {
        if (priceDebounceRef.current) clearTimeout(priceDebounceRef.current);
        priceDebounceRef.current = null;
      } catch {}
    };
  }, []);

  const fmtDate = (d) => {
    if (!d) return '';
    try {
      return new Date(d).toLocaleDateString('ru-RU');
    } catch {
      return '';
    }
  };

  const isDefaultDateRange = (() => {
    try {
      const df = filters?.dateFrom ? new Date(filters.dateFrom).getTime() : null;
      const dt = filters?.dateTo ? new Date(filters.dateTo).getTime() : null;
      const t0 = today ? new Date(today).getTime() : null;
      const t1 = twoWeeksLater ? new Date(twoWeeksLater).getTime() : null;
      return df === t0 && dt === t1;
    } catch {
      return false;
    }
  })();

  const handleFilterClick = (filter) => {
    const next = activeFilter === filter ? null : filter;
    setActiveFilter(next);

    // если открываем фильтр — сворачиваем карточку/лист, чтобы не накладывалось
    if (next) {
      try { setSelectedTripId?.(null); } catch {}
    }
  };

  const handlePriceChange = (e, type) => {
    const value = Number.parseInt(e.target.value, 10);

    const next = {
      ...(latestFiltersRef.current || filters),
      [type]: Number.isFinite(value) ? value : 0,
    };

    latestFiltersRef.current = next;
    setFilters(next);

    // debounce, чтобы не дергать фильтрацию на каждом "тике" ползунка
    if (priceDebounceRef.current) clearTimeout(priceDebounceRef.current);
    priceDebounceRef.current = setTimeout(() => {
      applyFilter('price', next);
    }, 120);
  };

  const handleAgeChange = (e) => {
    const value = Number.parseInt(e.target.value, 10);

    const next = {
      ...(latestFiltersRef.current || filters),
      age: Number.isFinite(value) ? value : '',
    };

    latestFiltersRef.current = next;
    setFilters(next);
    applyFilter('age', next);
  };

  const handleLeisureTypeSelect = (value) => {
    const next = {
      ...(latestFiltersRef.current || filters),
      leisureType: value,
    };

    latestFiltersRef.current = next;
    setFilters(next);
    applyFilter('leisureType', next);
    setActiveFilter(null);
  };

  const handleDifficultySelect = (value) => {
    const next = {
      ...(latestFiltersRef.current || filters),
      difficulty: value,
    };

    latestFiltersRef.current = next;
    setFilters(next);
    applyFilter('difficulty', next);
    setActiveFilter(null);
  };

  const handleDateChange = (dates) => {
    const [start, end] = dates;

    const next = {
      ...(latestFiltersRef.current || filters),
      dateFrom: start,
      dateTo: end,
    };

    latestFiltersRef.current = next;
    setFilters(next);
  };

  const applyDateFilter = () => {
    const next = latestFiltersRef.current || filters;
    if (next?.dateFrom && next?.dateTo) {
      applyFilter('date', next);
      setActiveFilter(null);
    }
  };

  const cancelDateFilter = () => setActiveFilter(null);

  return (
    <div className={styles.filters} ref={filtersRef}>
      {/* Цена */}
      <div className={styles.filterWrapper}>
        <button
          onClick={() => handleFilterClick('price')}
          className={`${styles.filterButton} ${filters.priceFrom || filters.priceTo ? styles.active : ''}`}
        >
          Цена
          {(filters.priceFrom || filters.priceTo) && (
            <>
              <span className={styles.filterValue}>
                {filters.priceFrom ? `${filters.priceFrom.toLocaleString()}₽` : '0₽'}
                {filters.priceTo ? ` - ${filters.priceTo.toLocaleString()}₽` : ' - 1 000 000₽'}
              </span>
              <span
                className={styles.clearIcon}
                onClick={(e) => { e.stopPropagation(); removeFilter('price'); }}
              >
                ✕
              </span>
            </>
          )}
        </button>

        {activeFilter === 'price' && (
          <div className={styles.filterDropdown}>
            <div className={styles.rangeContainer}>
              <div className={styles.rangeLabels}>
                <span>0₽</span>
                <span>1 000 000₽</span>
              </div>
              <div className={styles.rangeInputs}>
                <input
                  type="range"
                  min="0"
                  max="1000000"
                  step="10000"
                  value={filters.priceFrom || 0}
                  onChange={(e) => handlePriceChange(e, 'priceFrom')}
                  className={styles.rangeSlider}
                />
                <input
                  type="range"
                  min="0"
                  max="1000000"
                  step="10000"
                  value={filters.priceTo || 1000000}
                  onChange={(e) => handlePriceChange(e, 'priceTo')}
                  className={styles.rangeSlider}
                />
              </div>
              <div className={styles.rangeValues}>
                <span>{filters.priceFrom ? filters.priceFrom.toLocaleString() : '0'}₽</span>
                <span>{filters.priceTo ? filters.priceTo.toLocaleString() : '1 000 000'}₽</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Тип отдыха */}
      <div className={styles.filterWrapper}>
        <button
          onClick={() => handleFilterClick('leisureType')}
          className={`${styles.filterButton} ${filters.leisureType ? styles.active : ''}`}
        >
          Тип отдыха
          {filters.leisureType && (
            <>
              <span className={styles.filterValue}>{leisureTypeLabels[filters.leisureType]}</span>
              <span
                className={styles.clearIcon}
                onClick={(e) => { e.stopPropagation(); removeFilter('leisureType'); }}
              >
                ✕
              </span>
            </>
          )}
        </button>

        {activeFilter === 'leisureType' && (
          <div className={styles.filterDropdown}>
            {Object.entries(leisureTypeLabels).map(([key, label]) => (
              <button
                key={key}
                onClick={() => handleLeisureTypeSelect(key)}
                className={styles.filterOption}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Сложность */}
      <div className={styles.filterWrapper}>
        <button
          onClick={() => handleFilterClick('difficulty')}
          className={`${styles.filterButton} ${filters.difficulty ? styles.active : ''}`}
        >
          Сложность
          {filters.difficulty && (
            <>
              <span className={styles.filterValue}>{difficultyLabels[filters.difficulty]}</span>
              <span
                className={styles.clearIcon}
                onClick={(e) => { e.stopPropagation(); removeFilter('difficulty'); }}
              >
                ✕
              </span>
            </>
          )}
        </button>

        {activeFilter === 'difficulty' && (
          <div className={styles.filterDropdown}>
            {Object.entries(difficultyLabels).map(([key, label]) => (
              <button
                key={key}
                onClick={() => handleDifficultySelect(key)}
                className={styles.filterOption}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Возраст */}
      <div className={styles.filterWrapper}>
        <button
          onClick={() => handleFilterClick('age')}
          className={`${styles.filterButton} ${filters.age ? styles.active : ''}`}
        >
          Возраст
          {filters.age && (
            <>
              <span className={styles.filterValue}>{filters.age} лет</span>
              <span
                className={styles.clearIcon}
                onClick={(e) => { e.stopPropagation(); removeFilter('age'); }}
              >
                ✕
              </span>
            </>
          )}
        </button>

        {activeFilter === 'age' && (
          <div className={styles.filterDropdown}>
            <input
              type="range"
              min="1"
              max="100"
              step="1"
              value={filters.age || 18}
              onChange={handleAgeChange}
              className={styles.rangeSlider}
            />
            <div className={styles.rangeValues}>
              <span>{filters.age || 18} лет</span>
            </div>
          </div>
        )}
      </div>

      {/* ✅ Дата — показываем сразу всегда */}
      <div className={styles.filterWrapper}>
        <button
          onClick={() => handleFilterClick('date')}
          className={`${styles.filterButton} ${!isDefaultDateRange ? styles.active : ''}`}
        >
          Дата
          <span className={styles.filterValue}>
            {fmtDate(filters.dateFrom || today)} - {fmtDate(filters.dateTo || twoWeeksLater)}
          </span>

          {/* крестик показываем только если диапазон меняли */}
          {!isDefaultDateRange && (
            <span
              className={styles.clearIcon}
              onClick={(e) => { e.stopPropagation(); removeFilter('date'); }}
            >
              ✕
            </span>
          )}
        </button>

        {activeFilter === 'date' && (
          <div className={styles.filterDropdown}>
            <DatePicker
              selected={filters.dateFrom}
              onChange={handleDateChange}
              startDate={filters.dateFrom}
              endDate={filters.dateTo}
              selectsRange
              inline
              locale="ru"
              minDate={today}
            />
            <div className={styles.dateButtons}>
              <button onClick={applyDateFilter} className={styles.applyButton}>Применить</button>
              <button onClick={cancelDateFilter} className={styles.cancelButton}>Отмена</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
