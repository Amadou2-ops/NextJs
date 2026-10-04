/** Motifs normalisés d'une décision de revue d'identité (codes transmis à l'API). */
export const KYC_REASONS = [
  ["document_expired", "Pièce expirée"],
  ["document_unreadable", "Pièce illisible"],
  ["document_tampered", "Pièce altérée"],
  ["face_mismatch", "Visage différent de la pièce"],
  ["liveness_failed", "Détection du vivant échouée"],
  ["data_mismatch", "Identité différente de celle déclarée"],
  ["underage", "Client mineur"],
  ["duplicate_identity", "Pièce utilisée par un autre client"],
  ["suspected_fraud", "Suspicion de fraude"],
] as const;
