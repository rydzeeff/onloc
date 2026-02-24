function Error({ statusCode }) {
  return { error: `Error ${statusCode}` };
}

Error.getInitialProps = ({ res, err }) => {
  const statusCode = res ? res.statusCode : err ? err.statusCode : 404;
  if (res) {
    res.setHeader('Content-Type', 'application/json');
    res.write(JSON.stringify({ error: `Error ${statusCode}` }));
    res.end();
  }
  return { statusCode };
};

export default Error;