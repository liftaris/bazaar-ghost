export const VOD_QUERY = `
  query VideoChapters($id: ID!) {
    video(id: $id) {
      id
      title
      lengthSeconds
      publishedAt
      game {
        id
        name
        displayName
      }
      moments(first: 25, momentRequestType: VIDEO_CHAPTER_MARKERS) {
        edges {
          node {
            positionMilliseconds
            type
            description
            details {
              ... on GameChangeMomentDetails {
                game {
                  id
                  name
                  displayName
                }
              }
            }
          }
        }
      }
    }
  }
`;
