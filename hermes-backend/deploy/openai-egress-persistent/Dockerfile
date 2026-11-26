# Required build argument: an independently reviewed Python image by digest.
ARG PYTHON_IMAGE
FROM ${PYTHON_IMAGE}
WORKDIR /app
COPY proxy.py /app/proxy.py
USER 65534:65534
EXPOSE 3128
CMD ["python", "-I", "-u", "/app/proxy.py"]
