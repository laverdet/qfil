FROM debian:sid
RUN <<DONE
	set -eux
	apt update
	apt install -y \
		curl \
		entr \
		git \
		jq \
		locales-all \
		man \
		vim \
		yq \
	;
DONE
